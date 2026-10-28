#ifndef XCALE_WS_H
#define XCALE_WS_H

#include <stddef.h>

/* A small WebSocket client (RFC 6455) over plain TCP or OpenSSL: ws:// and wss://.
 * Single threaded; the socket is non-blocking once the connection is established. */
typedef struct ws ws_t;

/* Connects, does the TLS handshake (wss:// verifies the certificate and the host name against
 * cacert, or the system roots when cacert is NULL) and the HTTP upgrade. NULL on failure with
 * the reason in err. */
ws_t *ws_connect(const char *url, const char *cacert, int timeout_s, char *err, size_t errlen);

/* The socket, for poll(). */
int ws_fd(const ws_t *w);

/* Sends one text message. 0 on success, -1 when the connection is broken. */
int ws_send_text(ws_t *w, const char *msg, size_t len);

/* Receives the next text message if a whole one is available. Returns 1 (a malloc'ed,
 * NUL-terminated message in *out), 0 nothing yet, -1 closed or failed; *close_code is the code of
 * a close frame received from the server (0 if there was none). Pings are answered here. */
int ws_recv_text(ws_t *w, char **out, int *close_code);

/* Sends a close frame (best effort) and frees everything. */
void ws_close(ws_t *w);

#endif
