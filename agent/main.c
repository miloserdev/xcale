/*
 * xcale-agent: the program on every node. It connects to the xcale server over
 * WebSocket (JSON text frames, see server/src/protocol.ts) and
 *   - streams hardware sensors read from sysfs,
 *   - keeps its scripts directory (--root) in sync with the cluster (sync.c),
 *   - runs the tests the server asks for and returns their output (run.c).
 * The server needs no address of the node and no SSH: the agent connects out.
 *
 *   xcale-agent --url wss://host/agent --cluster NAME [--name NODE] --token CLUSTER_TOKEN
 *                 [--root /opt/xcale] [--cacert FILE] [--insecure] [--interval ms]
 *   xcale-agent --print            # list sensors and print one sample, no server
 *
 * The node names itself (--name, by default its host name) and proves that it belongs to the
 * cluster with the token of the cluster; the server registers it on the first connection.
 * "--server <cluster>.<node>" is the same as --cluster and --name together.
 * Options may also come from XCALE_URL, XCALE_CLUSTER, XCALE_NODE, XCALE_SERVER, XCALE_TOKEN,
 * XCALE_ROOT, XCALE_CACERT, XCALE_INSECURE (=1 is --insecure). A plain ws:// URL is refused unless --insecure is given (isolated
 * networks only): the agent runs what the server sends, so the channel has to be trusted.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <ifaddrs.h>
#include <jansson.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "agent.h"
#include "ws.h"

#define VERSION "0.2.0"
static volatile sig_atomic_t stop;
static int close_code; /* code of the last close frame received from the server */
#define CLOSE_REPLACED 4409

double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int read_str(const char *path, char *buf, size_t len) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    if (!fgets(buf, (int)len, f)) { fclose(f); return -1; }
    fclose(f);
    buf[strcspn(buf, "\n")] = 0;
    return 0;
}
/* ---- machine info (sent once in hello) ---- */

static int file_value(const char *path, const char *key, char *out, size_t len) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char line[512];
    size_t klen = strlen(key);
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, key, klen)) continue;
        char *v = line + klen;
        while (*v == ' ' || *v == '\t' || *v == ':' || *v == '=') v++;
        v[strcspn(v, "\n")] = 0;
        if (*v == '"') { v++; char *q = strrchr(v, '"'); if (q) *q = 0; }
        snprintf(out, len, "%s", v);
        fclose(f);
        return 0;
    }
    fclose(f);
    return -1;
}

static json_t *build_info(void) {
    json_t *o = json_object();
    char buf[256];
    if (file_value("/etc/os-release", "PRETTY_NAME", buf, sizeof buf) == 0)
        json_object_set_new(o, "os", json_string(buf));
    if (read_str("/proc/sys/kernel/osrelease", buf, sizeof buf) == 0)
        json_object_set_new(o, "kernel", json_string(buf));
    if (gethostname(buf, sizeof buf) == 0)
        json_object_set_new(o, "hostname", json_string(buf));
    if (file_value("/proc/cpuinfo", "model name", buf, sizeof buf) == 0)
        json_object_set_new(o, "cpu", json_string(buf));
    long threads = sysconf(_SC_NPROCESSORS_ONLN);
    if (threads > 0) json_object_set_new(o, "threads", json_integer(threads));
    if (file_value("/proc/meminfo", "MemTotal", buf, sizeof buf) == 0)
        json_object_set_new(o, "memory_kb", json_integer(atoll(buf)));
    if (file_value("/proc/stat", "btime", buf, sizeof buf) == 0)
        json_object_set_new(o, "boot_ts", json_integer(atoll(buf) * 1000));
    return o;
}

/* ---- protocol messages ---- */

/* MAC address of the interface that carries the connection to the server. */
static void local_mac(int fd, char *out, size_t n) {
    out[0] = 0;
    struct sockaddr_storage ss;
    socklen_t sl = sizeof ss;
    if (getsockname(fd, (struct sockaddr *)&ss, &sl) != 0) return;
    struct ifaddrs *list, *i;
    if (getifaddrs(&list) != 0) return;
    for (i = list; i; i = i->ifa_next) {
        if (!i->ifa_addr || i->ifa_addr->sa_family != ss.ss_family) continue;
        int same = 0;
        if (ss.ss_family == AF_INET)
            same = ((struct sockaddr_in *)i->ifa_addr)->sin_addr.s_addr == ((struct sockaddr_in *)&ss)->sin_addr.s_addr;
        else if (ss.ss_family == AF_INET6)
            same = !memcmp(&((struct sockaddr_in6 *)i->ifa_addr)->sin6_addr, &((struct sockaddr_in6 *)&ss)->sin6_addr, 16);
        if (!same) continue;
        char path[160];
        snprintf(path, sizeof path, "/sys/class/net/%s/address", i->ifa_name);
        if (read_str(path, out, n) != 0) out[0] = 0;
        break;
    }
    freeifaddrs(list);
    if (!strcmp(out, "00:00:00:00:00:00")) out[0] = 0;
}

static char *build_hello(const char *server, const char *token, const char *mac) {
    json_t *root = json_object();
    json_object_set_new(root, "type", json_string("hello"));
    json_object_set_new(root, "server", json_string(server));
    json_object_set_new(root, "token", json_string(token));
    json_object_set_new(root, "version", json_string(VERSION));
    if (mac && *mac) json_object_set_new(root, "mac", json_string(mac));
    json_object_set_new(root, "root", json_string(root_dir));
    json_object_set_new(root, "info", build_info());
    json_object_set_new(root, "runs", run_hello_runs());
    json_t *arr = json_array();
    for (int i = 0; i < sensors_count(); i++) {
        const char *id, *label, *kind, *unit;
        sensors_describe(i, &id, &label, &kind, &unit);
        json_t *o = json_object();
        json_object_set_new(o, "id", json_string(id));
        json_object_set_new(o, "kind", json_string(kind));
        json_object_set_new(o, "label", json_string(label));
        json_object_set_new(o, "unit", json_string(unit));
        json_array_append_new(arr, o);
    }
    json_object_set_new(root, "sensors", arr);
    char *s = json_dumps(root, JSON_COMPACT);
    json_decref(root);
    return s;
}

static char *build_sample(void) {
    int n = sensors_count();
    double *values = calloc((size_t)(n ? n : 1), sizeof *values);
    int *ok = calloc((size_t)(n ? n : 1), sizeof *ok);
    if (!values || !ok) { free(values); free(ok); return NULL; }
    sensors_read_all(values, ok);
    json_t *root = json_object();
    json_object_set_new(root, "type", json_string("sample"));
    json_object_set_new(root, "ts", json_integer(now_ms()));
    json_t *vals = json_object();
    for (int i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const char *id, *label, *kind, *unit;
        sensors_describe(i, &id, &label, &kind, &unit);
        json_object_set_new(vals, id, json_real(values[i]));
    }
    json_object_set_new(root, "values", vals);
    char *s = json_dumps(root, JSON_COMPACT);
    json_decref(root);
    free(values);
    free(ok);
    return s;
}

/* ---- shared with the other modules ---- */

const char *root_dir = "/opt/xcale";

void log_msg(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

/* ---- the connection (ws.c) ---- */

static ws_t *conn;        /* NULL while there is no connection */
static int online;        /* the server answered the hello: events may be sent */
static int link_broken;   /* a send failed: drop the connection at the next turn */
static int exit_code;

int is_connected(void) { return online; }

static int send_text(ws_t *c, const char *msg) { return ws_send_text(c, msg, strlen(msg)); }

int send_raw(const char *msg) {
    if (!conn || !online) return -1;
    if (send_text(conn, msg) != 0) { link_broken = 1; return -1; }
    return 0;
}

int send_json(json_t *msg) {
    char *s = json_dumps(msg, JSON_COMPACT);
    if (!s) return -1;
    int rc = send_raw(s);
    free(s);
    return rc;
}

/* Receives one message if available. Returns 1 got a message (malloc'ed in *out),
 * 0 nothing yet, -1 closed or failed. */
static int recv_text(ws_t *c, char **out) { return ws_recv_text(c, out, &close_code); }

static const char *g_url, *g_server, *g_token, *g_cacert;
static int g_interval = 1000;

static void disconnect(void) {
    if (conn) ws_close(conn);
    conn = NULL;
    online = 0;
    link_broken = 0;
    sync_abort();
    run_on_disconnected();
}

/* Connects, sends the hello and waits for the welcome. Returns 0 when connected. */
static int connect_server(void) {
    char err[256] = "";
    conn = ws_connect(g_url, g_cacert, 10, err, sizeof err);
    if (!conn) {
        log_msg("connect failed: %s", err);
        disconnect();
        return -1;
    }

    char mac[32] = "";
    int fd = ws_fd(conn);
    local_mac(fd, mac, sizeof mac);
    char *hello = build_hello(g_server, g_token, mac);
    int ok = hello && send_text(conn, hello) == 0;
    free(hello);

    /* the scripts keep running while we wait */
    char *msg = NULL;
    int r = 0;
    for (double deadline = now_s() + 10; ok && r == 0 && now_s() < deadline && !stop;) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        poll(&pfd, 1, 200);
        run_pump();
        r = recv_text(conn, &msg);
    }
    if (!ok || r != 1) { disconnect(); return -1; }

    json_t *j = json_loads(msg, 0, NULL);
    free(msg);
    const char *type = j ? json_string_value(json_object_get(j, "type")) : NULL;
    if (type && !strcmp(type, "welcome")) {
        json_t *iv = json_object_get(j, "interval_ms");
        if (json_is_integer(iv) && json_integer_value(iv) >= 200) g_interval = (int)json_integer_value(iv);
        online = 1;
        json_decref(j);
        log_msg("connected, %d sensors, every %d ms, scripts in %s%s%s", sensors_count(), g_interval, root_dir,
                *mac ? ", mac " : "", mac);
        return 0;
    }
    const char *m = j ? json_string_value(json_object_get(j, "message")) : NULL;
    log_msg("server refused: %s", m ? m : "unexpected reply");
    json_decref(j);
    disconnect();
    return -1;
}

static void handle_message(const char *text) {
    json_t *msg = json_loads(text, 0, NULL);
    if (!msg) return;
    const char *type = json_string_value(json_object_get(msg, "type"));
    if (!type) { json_decref(msg); return; }
    if (!strcmp(type, "sync")) sync_handle_sync(msg);
    else if (!strcmp(type, "file")) sync_handle_file(msg);
    else if (!strcmp(type, "run")) run_handle_run(msg);
    else if (!strcmp(type, "stop")) run_handle_stop(msg);
    else if (!strcmp(type, "run_ack")) run_handle_ack(msg);
    else if (!strcmp(type, "forget")) run_handle_forget(msg);
    else if (!strcmp(type, "error")) log_msg("server: %s", json_string_value(json_object_get(msg, "message")));
    json_decref(msg);
}

/* The main loop: the socket, the output of the running script and the timers. */
static void serve(void) {
    double next_sample = 0, next_connect = 0, connected_at = 0;
    int backoff = 1;
    while (!stop) {
        double now = now_s();
        if (!conn && now >= next_connect) {
            close_code = 0;
            if (connect_server() == 0) {
                connected_at = now_s();
                next_sample = connected_at;
                run_on_connected();
            } else {
                if (close_code == CLOSE_REPLACED) {
                    log_msg("another agent connected with the same server id, exiting");
                    exit_code = 1;
                    break;
                }
                /* while a test depends on the server the pause stays short */
                int wait = run_needs_server() && backoff > 3 ? 3 : backoff;
                next_connect = now_s() + wait;
                log_msg("reconnecting in %d s", wait);
                if (backoff < 30) backoff *= 2;
            }
        }

        struct pollfd p[2];
        int nfds = 0, timeout = 200;
        if (conn) {
            p[nfds++] = (struct pollfd){ .fd = ws_fd(conn), .events = POLLIN };
            int until = (int)((next_sample - now_s()) * 1000);
            if (until < timeout) timeout = until > 0 ? until : 0;
        }
        int rf = run_poll_fd();
        if (rf >= 0) p[nfds++] = (struct pollfd){ .fd = rf, .events = POLLIN };
        if (nfds) poll(p, (nfds_t)nfds, timeout);
        else usleep((useconds_t)timeout * 1000);

        run_pump();

        if (conn) {
            char *in;
            int r;
            while ((r = recv_text(conn, &in)) == 1) {
                handle_message(in);
                free(in);
                if (stop) break;
            }
            if (r < 0 || link_broken) {
                if (close_code == CLOSE_REPLACED) {
                    log_msg("another agent connected with the same server id, exiting");
                    exit_code = 1;
                    stop = 1;
                    disconnect();
                    break;
                }
                log_msg("connection lost");
                disconnect();
                if (now_s() - connected_at > 30) backoff = 1;
                next_connect = now_s() + 1; /* the first retry is quick */
                continue;
            }
            if (now_s() >= next_sample) {
                char *sample = build_sample();
                if (sample) { send_raw(sample); free(sample); }
                next_sample += g_interval / 1000.0;
                if (next_sample < now_s()) next_sample = now_s() + g_interval / 1000.0;
            }
        }
    }
    if (conn) disconnect(); /* sends the close frame */
}

static void on_signal(int sig) { (void)sig; stop = 1; }

int main(int argc, char **argv) {
    const char *url = getenv("XCALE_URL");
    const char *server = getenv("XCALE_SERVER");
    const char *cluster = getenv("XCALE_CLUSTER");
    const char *node = getenv("XCALE_NODE");
    const char *token = getenv("XCALE_TOKEN");
    const char *root = getenv("XCALE_ROOT");
    const char *cacert = getenv("XCALE_CACERT");
    const char *sensors_conf = getenv("XCALE_SENSORS_CONF");
    int interval_ms = 1000, print_only = 0, insecure = 0;
    const char *insecure_env = getenv("XCALE_INSECURE");
    if (insecure_env && *insecure_env && strcmp(insecure_env, "0")) insecure = 1;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--url") && i + 1 < argc) url = argv[++i];
        else if (!strcmp(argv[i], "--server") && i + 1 < argc) server = argv[++i];
        else if (!strcmp(argv[i], "--cluster") && i + 1 < argc) cluster = argv[++i];
        else if (!strcmp(argv[i], "--name") && i + 1 < argc) node = argv[++i];
        else if (!strcmp(argv[i], "--token") && i + 1 < argc) token = argv[++i];
        else if (!strcmp(argv[i], "--root") && i + 1 < argc) root = argv[++i];
        else if (!strcmp(argv[i], "--cacert") && i + 1 < argc) cacert = argv[++i];
        else if (!strcmp(argv[i], "--sensors-conf") && i + 1 < argc) sensors_conf = argv[++i];
        else if (!strcmp(argv[i], "--interval") && i + 1 < argc) interval_ms = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--insecure")) insecure = 1;
        else if (!strcmp(argv[i], "--print")) print_only = 1;
        else {
            fprintf(stderr,
                    "usage: %s --url wss://host/agent --cluster NAME [--name NODE] --token CLUSTER_TOKEN\n"
                    "          [--root /opt/xcale] [--cacert FILE] [--insecure] [--interval ms]\n"
                    "          [--sensors-conf FILE] | --print\n",
                    argv[0]);
            return 2;
        }
    }
    if (interval_ms < 200) interval_ms = 200;
    if (root) root_dir = root;

    sensors_discover(sensors_conf);

    if (print_only) {
        int n = sensors_count();
        printf("%d sensors\n", n);
        for (int i = 0; i < n; i++) {
            const char *id, *label, *kind, *unit;
            sensors_describe(i, &id, &label, &kind, &unit);
            printf("  %-40s %-12s %-5s %s\n", id, kind, unit, label);
        }
        char *s = build_sample();
        printf("%s\n", s ? s : "{}");
        free(s);
        sensors_shutdown();
        return 0;
    }
    char id[160];
    if (!server && cluster) {
        // the node name: --name or the host name up to the first dot, as a valid name
        char host[128] = "";
        if (!node && gethostname(host, sizeof host - 1) == 0) {
            host[strcspn(host, ".")] = 0;
            for (char *p = host; *p; p++)
                if (!isalnum((unsigned char)*p) && *p != '_' && *p != '-') *p = '_';
            if (host[0] == '-') host[0] = '_';
            node = host;
        }
        if (!node || !*node) {
            fprintf(stderr, "cannot tell the node name: pass --name\n");
            return 2;
        }
        snprintf(id, sizeof id, "%s.%s", cluster, node);
        server = id;
    }
    if (!url || !server || !token) {
        fprintf(stderr, "need --url, --cluster (or --server <cluster>.<node>) and --token\n"
                        "(or XCALE_URL, XCALE_CLUSTER, XCALE_TOKEN)\n");
        return 2;
    }
    if (!strncmp(url, "ws://", 5) && !insecure) {
        fprintf(stderr,
                "refusing the plain ws:// URL: the agent runs what the server sends, so the channel must be\n"
                "encrypted and the server verified. Use a wss:// URL, or --insecure on an isolated network.\n");
        return 2;
    }
    if (strncmp(url, "ws://", 5) && strncmp(url, "wss://", 6)) {
        fprintf(stderr, "the URL must start with wss:// (or ws:// with --insecure)\n");
        return 2;
    }
    if (sensors_count() == 0) fprintf(stderr, "warning: no sensors found\n");
    g_url = url; g_server = server; g_token = token; g_cacert = cacert; g_interval = interval_ms;

    struct sigaction sa = { .sa_handler = on_signal };
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    serve();

    run_shutdown();
    sensors_shutdown();
    return exit_code;
}
