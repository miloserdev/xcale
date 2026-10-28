#ifndef XCALE_AGENT_H
#define XCALE_AGENT_H

#include <jansson.h>
#include <stddef.h>

/* ---- main.c: the connection to the server ---- */
double now_s(void);
extern const char *root_dir;         /* scripts directory of the node, e.g. /opt/xcale */
int is_connected(void);
int send_json(json_t *msg);          /* 0 sent, -1 not connected or failed; does not steal msg */
int send_raw(const char *msg);       /* same for an already serialized message */
void log_msg(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
int read_str(const char *path, char *buf, size_t len); /* first line of a file, 0 on success */

/* ---- sensors.c: libsensors plus load and CPU frequency ---- */
void sensors_discover(const char *conf_path);   /* conf_path: an alternative sensors.conf, or NULL */
int sensors_count(void);
void sensors_describe(int i, const char **id, const char **label, const char **kind, const char **unit);
void sensors_read_all(double *values, int *ok); /* ok[i]: values[i] is valid */
void sensors_shutdown(void);

/* ---- sync.c: copying the scripts directory from the server ---- */
int safe_rel(const char *path);      /* 1 for a plain relative path inside the root */
void sync_handle_sync(json_t *msg);  /* "sync": the manifest */
void sync_handle_file(json_t *msg);  /* "file": a chunk of a file */
void sync_abort(void);               /* the connection was lost */

/* ---- run.c: running the scripts of a test ---- */
void run_handle_run(json_t *msg);
void run_handle_stop(json_t *msg);
void run_handle_ack(json_t *msg);
void run_handle_forget(json_t *msg);
json_t *run_hello_runs(void);        /* "runs" of the hello message */
void run_on_connected(void);         /* resend what the server has not acknowledged */
void run_on_disconnected(void);      /* start the grace period */
int run_needs_server(void);          /* a test is running or has events the server has not acknowledged */
int run_poll_fd(void);               /* fd to poll for output, or -1 */
void run_pump(void);                 /* output, exit of scripts, timers; call often */
void run_shutdown(void);             /* the agent exits: stop the scripts */

#endif
