#define _GNU_SOURCE
#include "ws.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define MAX_MESSAGE (4u << 20)       /* a message must stay far below this */
#define MAX_HEADER  (16u << 10)
#define GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

struct ws {
    int fd;
    SSL_CTX *ctx;
    SSL *ssl;
    unsigned char *rx;               /* bytes received and not parsed yet */
    size_t rx_len, rx_cap;
    unsigned char *msg;              /* the message being assembled from fragments */
    size_t msg_len;
    int msg_text;                    /* the message in `msg` is text */
    int in_msg;                      /* a fragmented message is being received */
    int broken;
};

static double mono(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void fail(char *err, size_t n, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void fail(char *err, size_t n, const char *fmt, ...) {
    if (!err || !n) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, n, fmt, ap);
    va_end(ap);
}

/* ---- transport: plain socket or TLS, non-blocking after the handshake ---- */

/* Reads what is available. >0 bytes, 0 would block, -1 closed or failed. */
static ssize_t t_read(ws_t *w, void *buf, size_t len) {
    if (w->ssl) {
        int n = SSL_read(w->ssl, buf, (int)len);
        if (n > 0) return n;
        int e = SSL_get_error(w->ssl, n);
        if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) return 0;
        return -1;
    }
    ssize_t n = recv(w->fd, buf, len, 0);
    if (n > 0) return n;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
    return -1;
}

/* Writes everything, waiting up to timeout_ms for the socket to drain. 0 on success. */
static int t_write_all(ws_t *w, const void *buf, size_t len, int timeout_ms) {
    const unsigned char *p = buf;
    double deadline = mono() + timeout_ms / 1000.0;
    while (len) {
        short wait_for = POLLOUT;
        ssize_t n;
        if (w->ssl) {
            int r = SSL_write(w->ssl, p, (int)len);
            if (r > 0) n = r;
            else {
                int e = SSL_get_error(w->ssl, r);
                if (e == SSL_ERROR_WANT_WRITE) { n = 0; wait_for = POLLOUT; }
                else if (e == SSL_ERROR_WANT_READ) { n = 0; wait_for = POLLIN; }
                else return -1;
            }
        } else {
            n = send(w->fd, p, len, MSG_NOSIGNAL);
            if (n < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) n = 0;
                else return -1;
            }
        }
        if (n > 0) { p += n; len -= (size_t)n; continue; }
        double left = deadline - mono();
        if (left <= 0) return -1;
        struct pollfd pfd = { .fd = w->fd, .events = wait_for };
        poll(&pfd, 1, (int)(left * 1000) + 1);
    }
    return 0;
}

/* ---- connecting ---- */

typedef struct {
    int tls;
    char host[256];
    char port[8];
    char path[1024];
    char hostport[300];              /* for the Host header */
} url_t;

static int parse_url(const char *url, url_t *u, char *err, size_t errlen) {
    memset(u, 0, sizeof *u);
    const char *p;
    if (!strncmp(url, "wss://", 6)) { u->tls = 1; p = url + 6; }
    else if (!strncmp(url, "ws://", 5)) { p = url + 5; }
    else { fail(err, errlen, "the URL must start with ws:// or wss://"); return -1; }

    const char *end = p + strcspn(p, "/?#");
    const char *host = p, *hend, *port = NULL;
    if (*p == '[') {                 /* [IPv6]:port */
        hend = strchr(p, ']');
        if (!hend || hend > end) { fail(err, errlen, "bad IPv6 address in the URL"); return -1; }
        host = p + 1;
        if (hend + 1 < end && hend[1] == ':') port = hend + 2;
    } else {
        const char *colon = memchr(p, ':', (size_t)(end - p));
        hend = colon ? colon : end;
        if (colon) port = colon + 1;
    }
    size_t hl = (size_t)(hend - host);
    if (!hl || hl >= sizeof u->host) { fail(err, errlen, "bad host in the URL"); return -1; }
    memcpy(u->host, host, hl);
    if (port && port < end) {
        size_t pl = (size_t)(end - port);
        if (pl >= sizeof u->port || !pl) { fail(err, errlen, "bad port in the URL"); return -1; }
        memcpy(u->port, port, pl);
    } else {
        strcpy(u->port, u->tls ? "443" : "80");
    }
    /* "host", "host?x" and "host/p" -> "/", "/?x", "/p" */
    snprintf(u->path, sizeof u->path, *end == '/' ? "%s" : "/%s", end);
    char *hash = strchr(u->path, '#');
    if (hash) *hash = 0;
    const char *shown = strchr(u->host, ':') ? "[%s]" : "%s";
    int defaultport = !strcmp(u->port, u->tls ? "443" : "80");
    char hostpart[264];
    snprintf(hostpart, sizeof hostpart, shown, u->host);
    if (defaultport) snprintf(u->hostport, sizeof u->hostport, "%s", hostpart);
    else snprintf(u->hostport, sizeof u->hostport, "%s:%s", hostpart, u->port);
    return 0;
}

static int tcp_connect(const url_t *u, int timeout_s, char *err, size_t errlen) {
    struct addrinfo hints = { .ai_socktype = SOCK_STREAM, .ai_family = AF_UNSPEC }, *list;
    int rc = getaddrinfo(u->host, u->port, &hints, &list);
    if (rc != 0) { fail(err, errlen, "cannot resolve %s: %s", u->host, gai_strerror(rc)); return -1; }
    double deadline = mono() + timeout_s;
    int fd = -1;
    const char *last = "no address";
    for (struct addrinfo *a = list; a && fd < 0; a = a->ai_next) {
        int s = socket(a->ai_family, a->ai_socktype | SOCK_CLOEXEC | SOCK_NONBLOCK, a->ai_protocol);
        if (s < 0) { last = strerror(errno); continue; }
        int r = connect(s, a->ai_addr, a->ai_addrlen);
        if (r < 0 && errno == EINPROGRESS) {
            double left = deadline - mono();
            struct pollfd pfd = { .fd = s, .events = POLLOUT };
            if (left > 0 && poll(&pfd, 1, (int)(left * 1000) + 1) == 1) {
                int e = 0;
                socklen_t el = sizeof e;
                getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &el);
                if (e == 0) r = 0; else errno = e;
            } else {
                errno = ETIMEDOUT;
            }
        }
        if (r == 0) fd = s;
        else { last = strerror(errno); close(s); }
    }
    freeaddrinfo(list);
    if (fd < 0) fail(err, errlen, "cannot connect to %s:%s: %s", u->host, u->port, last);
    return fd;
}

static int tls_handshake(ws_t *w, const url_t *u, const char *cacert, int timeout_s, char *err, size_t errlen) {
    w->ctx = SSL_CTX_new(TLS_client_method());
    if (!w->ctx) { fail(err, errlen, "cannot set up TLS"); return -1; }
    SSL_CTX_set_min_proto_version(w->ctx, TLS1_2_VERSION);
    SSL_CTX_set_verify(w->ctx, SSL_VERIFY_PEER, NULL);
    SSL_CTX_set_mode(w->ctx, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    int loaded = cacert ? SSL_CTX_load_verify_locations(w->ctx, cacert, NULL)
                        : SSL_CTX_set_default_verify_paths(w->ctx);
    if (!loaded) {
        fail(err, errlen, cacert ? "cannot read the CA file %s" : "cannot load the system CA certificates", cacert);
        return -1;
    }
    w->ssl = SSL_new(w->ctx);
    if (!w->ssl) { fail(err, errlen, "cannot set up TLS"); return -1; }
    SSL_set_fd(w->ssl, w->fd);

    unsigned char addr[16];
    int is_ip = inet_pton(AF_INET, u->host, addr) == 1 || inet_pton(AF_INET6, u->host, addr) == 1;
    if (is_ip) X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(w->ssl), u->host);
    else {
        SSL_set_tlsext_host_name(w->ssl, u->host);
        SSL_set1_host(w->ssl, u->host);
    }

    double deadline = mono() + timeout_s;
    for (;;) {
        int r = SSL_connect(w->ssl);
        if (r == 1) return 0;
        int e = SSL_get_error(w->ssl, r);
        if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
            double left = deadline - mono();
            struct pollfd pfd = { .fd = w->fd, .events = e == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT };
            if (left > 0 && poll(&pfd, 1, (int)(left * 1000) + 1) > 0) continue;
            fail(err, errlen, "TLS handshake timed out");
            return -1;
        }
        long v = SSL_get_verify_result(w->ssl);
        if (v != X509_V_OK) fail(err, errlen, "certificate verification failed: %s", X509_verify_cert_error_string(v));
        else fail(err, errlen, "TLS handshake failed: %s", ERR_reason_error_string(ERR_peek_last_error()) ?: "connection closed");
        return -1;
    }
}

static void base64(const unsigned char *in, int n, char *out) {
    EVP_EncodeBlock((unsigned char *)out, in, n);
}

static int upgrade(ws_t *w, const url_t *u, int timeout_s, char *err, size_t errlen) {
    unsigned char nonce[16];
    char key[32], expect[40];
    if (RAND_bytes(nonce, sizeof nonce) != 1) { fail(err, errlen, "no random numbers"); return -1; }
    base64(nonce, sizeof nonce, key);

    unsigned char digest[20];
    char joined[96];
    snprintf(joined, sizeof joined, "%s%s", key, GUID);
    unsigned int dl = 0;
    EVP_Digest(joined, strlen(joined), digest, &dl, EVP_sha1(), NULL);
    base64(digest, 20, expect);

    char req[1600];
    int n = snprintf(req, sizeof req,
                     "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: xcale-agent\r\n\r\n",
                     u->path, u->hostport, key);
    if (n <= 0 || (size_t)n >= sizeof req) { fail(err, errlen, "the URL is too long"); return -1; }
    if (t_write_all(w, req, (size_t)n, timeout_s * 1000) != 0) { fail(err, errlen, "cannot send the upgrade request"); return -1; }

    /* the response up to the blank line; whatever follows belongs to the WebSocket stream */
    char head[MAX_HEADER];
    size_t have = 0;
    char *blank = NULL;
    double deadline = mono() + timeout_s;
    while (!blank) {
        if (have >= sizeof head - 1) { fail(err, errlen, "the response header is too large"); return -1; }
        ssize_t r = t_read(w, head + have, sizeof head - 1 - have);
        if (r < 0) { fail(err, errlen, "the server closed the connection during the handshake"); return -1; }
        if (r == 0) {
            double left = deadline - mono();
            struct pollfd pfd = { .fd = w->fd, .events = POLLIN };
            if (left <= 0 || poll(&pfd, 1, (int)(left * 1000) + 1) <= 0) { fail(err, errlen, "the handshake timed out"); return -1; }
            continue;
        }
        have += (size_t)r;
        head[have] = 0;
        blank = strstr(head, "\r\n\r\n");
    }
    size_t header_len = (size_t)(blank - head) + 4;

    int status = 0;
    if (sscanf(head, "HTTP/%*d.%*d %d", &status) != 1 || status != 101) {
        fail(err, errlen, status ? "the server answered HTTP %d instead of switching to WebSocket (is the URL right?)"
                                 : "the server did not answer with HTTP",
             status);
        return -1;
    }
    int accepted = 0;
    for (char *line = strstr(head, "\r\n"); line && line < blank + 2;) {
        line += 2;
        if (!strncasecmp(line, "Sec-WebSocket-Accept:", 21)) {
            char *v = line + 21;
            while (*v == ' ') v++;
            size_t vl = strcspn(v, "\r\n");
            while (vl && v[vl - 1] == ' ') vl--;
            accepted = vl == strlen(expect) && !strncmp(v, expect, vl);
        }
        line = strstr(line, "\r\n");
    }
    if (!accepted) { fail(err, errlen, "the server did not confirm the WebSocket handshake"); return -1; }

    if (have > header_len) {
        w->rx_len = have - header_len;
        w->rx_cap = w->rx_len + 4096;
        w->rx = malloc(w->rx_cap);
        if (!w->rx) { fail(err, errlen, "out of memory"); return -1; }
        memcpy(w->rx, head + header_len, w->rx_len);
    }
    return 0;
}

ws_t *ws_connect(const char *url, const char *cacert, int timeout_s, char *err, size_t errlen) {
    url_t u;
    if (parse_url(url, &u, err, errlen) != 0) return NULL;
    ws_t *w = calloc(1, sizeof *w);
    if (!w) { fail(err, errlen, "out of memory"); return NULL; }
    w->fd = tcp_connect(&u, timeout_s, err, errlen);
    if (w->fd < 0) { free(w); return NULL; }
    int one = 1;
    setsockopt(w->fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    setsockopt(w->fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);

    if ((u.tls && tls_handshake(w, &u, cacert, timeout_s, err, errlen) != 0) ||
        upgrade(w, &u, timeout_s, err, errlen) != 0) {
        w->broken = 1; /* nothing to say goodbye to */
        ws_close(w);
        return NULL;
    }
    return w;
}

int ws_fd(const ws_t *w) { return w->fd; }

/* ---- frames ---- */

static int send_frame(ws_t *w, int opcode, const void *payload, size_t len) {
    if (w->broken) return -1;
    unsigned char head[14];
    size_t hl = 0;
    head[hl++] = (unsigned char)(0x80 | opcode);
    if (len < 126) head[hl++] = (unsigned char)(0x80 | len);
    else if (len < 65536) {
        head[hl++] = 0x80 | 126;
        head[hl++] = (unsigned char)(len >> 8);
        head[hl++] = (unsigned char)len;
    } else {
        head[hl++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) head[hl++] = (unsigned char)((uint64_t)len >> (8 * i));
    }
    unsigned char mask[4];
    if (RAND_bytes(mask, 4) != 1) return -1;
    memcpy(head + hl, mask, 4);
    hl += 4;

    unsigned char *frame = malloc(hl + len);
    if (!frame) return -1;
    memcpy(frame, head, hl);
    const unsigned char *in = payload;
    for (size_t i = 0; i < len; i++) frame[hl + i] = in[i] ^ mask[i & 3];
    int rc = t_write_all(w, frame, hl + len, 10000);
    free(frame);
    if (rc != 0) w->broken = 1;
    return rc;
}

int ws_send_text(ws_t *w, const char *msg, size_t len) { return send_frame(w, 0x1, msg, len); }

static int rx_fill(ws_t *w) {
    if (w->rx_cap - w->rx_len < 4096) {
        size_t cap = w->rx_cap ? w->rx_cap * 2 : 16384;
        unsigned char *grown = realloc(w->rx, cap);
        if (!grown) return -1;
        w->rx = grown;
        w->rx_cap = cap;
    }
    ssize_t n = t_read(w, w->rx + w->rx_len, w->rx_cap - w->rx_len);
    if (n < 0) return -1;
    w->rx_len += (size_t)n;
    return n > 0 ? 1 : 0;
}

/* Parses one frame from the buffer. 1 a frame was consumed (its effects are in `state`),
 * 0 more bytes needed, -1 protocol error or close. */
static int parse_frame(ws_t *w, char **out, int *close_code) {
    if (w->rx_len < 2) return 0;
    const unsigned char *b = w->rx;
    int fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    uint64_t len = b[1] & 0x7f;
    size_t pos = 2;
    if (b[0] & 0x70) return -1; /* reserved bits: no extensions were negotiated */
    if (len == 126) {
        if (w->rx_len < 4) return 0;
        len = (uint64_t)b[2] << 8 | b[3];
        pos = 4;
    } else if (len == 127) {
        if (w->rx_len < 10) return 0;
        len = 0;
        for (int i = 0; i < 8; i++) len = len << 8 | b[2 + i];
        pos = 10;
    }
    if (len > MAX_MESSAGE) return -1;
    unsigned char mask[4] = { 0 };
    if (masked) {
        if (w->rx_len < pos + 4) return 0;
        memcpy(mask, b + pos, 4);
        pos += 4;
    }
    if (w->rx_len < pos + len) return 0;

    unsigned char *payload = w->rx + pos;
    if (masked) for (size_t i = 0; i < len; i++) payload[i] ^= mask[i & 3];

    int result = 1;
    if (op >= 0x8) {                 /* control frames */
        if (!fin || len > 125) return -1;
        if (op == 0x8) {
            if (len >= 2) *close_code = payload[0] << 8 | payload[1];
            send_frame(w, 0x8, payload, len >= 2 ? 2 : 0);
            return -1;
        }
        if (op == 0x9) send_frame(w, 0xA, payload, len);
    } else if (op == 0x1 || op == 0x2 || op == 0x0) {
        if (op == 0x0 ? !w->in_msg : w->in_msg) return -1; /* continuation without a start, or a new message inside one */
        if (op != 0x0) { w->msg_text = op == 0x1; w->msg_len = 0; }
        w->in_msg = !fin;
        if (w->msg_len + len > MAX_MESSAGE) return -1;
        unsigned char *grown = realloc(w->msg, w->msg_len + len + 1);
        if (!grown) return -1;
        w->msg = grown;
        memcpy(w->msg + w->msg_len, payload, len);
        w->msg_len += len;
        if (fin) {
            w->msg[w->msg_len] = 0;
            if (w->msg_text) { *out = (char *)w->msg; w->msg = NULL; }
            else { free(w->msg); w->msg = NULL; }   /* binary messages are not used */
            w->msg_len = 0;
            w->msg_text = 0;
        }
    } else {
        return -1;
    }

    size_t used = pos + len;
    memmove(w->rx, w->rx + used, w->rx_len - used);
    w->rx_len -= used;
    return result;
}

int ws_recv_text(ws_t *w, char **out, int *close_code) {
    *out = NULL;
    if (w->broken) return -1;
    for (;;) {
        int r = parse_frame(w, out, close_code);
        if (r < 0) { w->broken = 1; return -1; }
        if (r == 1) {
            if (*out) return 1;
            continue;                /* a control frame or a fragment: the next one */
        }
        int got = rx_fill(w);
        if (got < 0) { w->broken = 1; return -1; }
        if (got == 0) return 0;
    }
}

void ws_close(ws_t *w) {
    if (!w) return;
    if (!w->broken && w->fd >= 0) {
        unsigned char code[2] = { 0x03, 0xe8 }; /* 1000 */
        send_frame(w, 0x8, code, 2);
    }
    if (w->ssl) {
        SSL_shutdown(w->ssl);
        SSL_free(w->ssl);
    }
    if (w->ctx) SSL_CTX_free(w->ctx);
    if (w->fd >= 0) close(w->fd);
    free(w->rx);
    free(w->msg);
    free(w);
}
