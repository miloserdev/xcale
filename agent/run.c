/*
 * Running the scripts of a test on this node (see server/src/agents.ts for the other side).
 *
 * The server sends `run` with a list of scripts. They run one after another from the
 * scripts directory (/bin/bash <script>, own session, stdout and stderr merged). Output,
 * the start and the exit of every script and the end of the test are sent as numbered
 * `run` events. The server acknowledges them with `run_ack`; unacknowledged events are
 * kept and sent again after a lost connection. If the connection stays lost for the
 * grace period (60 s) the test is stopped.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "agent.h"

#define MAX_RUNS 8
#define MAX_SCRIPTS 20
#define MAX_LINE 4000
#define BATCH_LINES 50
#define BATCH_SECONDS 0.1
#define MAX_BUFFER_BYTES (8 * 1024 * 1024)
#define STOP_GRACE_SECONDS 5.0

typedef struct ev {
    long seq;
    char *json;
    size_t len;
    struct ev *next;
} ev_t;

typedef struct {
    int used;
    char id[100];
    char *scripts[MAX_SCRIPTS];
    int n_scripts, cur;
    json_t *env;
    pid_t pid;
    int fd;
    char line[MAX_LINE + 1];
    size_t linelen;
    json_t *pending;
    double pending_since;
    long next_seq, acked, sent;
    ev_t *head, *tail;
    size_t bytes;
    long dropped;
    int finished;
    int forgotten;
    int stopping;
    const char *final_status; /* "stopped" or "lost" once a stop was requested */
    double kill_at;
    double lost_at; /* > 0 while the connection is down */
} run_t;

static run_t runs[MAX_RUNS];

static double grace_seconds(void) {
    const char *v = getenv("XCALE_AGENT_GRACE");
    return v && atof(v) > 0 ? atof(v) : 60.0;
}

static run_t *find_run(const char *id) {
    for (int i = 0; i < MAX_RUNS; i++)
        if (runs[i].used && !strcmp(runs[i].id, id)) return &runs[i];
    return NULL;
}

static int has_active_run(void) {
    for (int i = 0; i < MAX_RUNS; i++)
        if (runs[i].used && !runs[i].finished) return 1;
    return 0;
}

static void queue_free(run_t *r) {
    while (r->head) {
        ev_t *e = r->head;
        r->head = e->next;
        free(e->json);
        free(e);
    }
    r->tail = NULL;
    r->bytes = 0;
}

static void release(run_t *r) {
    queue_free(r);
    for (int i = 0; i < r->n_scripts; i++) free(r->scripts[i]);
    if (r->env) json_decref(r->env);
    if (r->pending) json_decref(r->pending);
    if (r->fd >= 0) close(r->fd);
    memset(r, 0, sizeof *r);
    r->fd = -1;
}

/* ---- events ---- */

static void drop_oldest_output(run_t *r) {
    /* the connection is down for long and the output piles up: drop old output events */
    ev_t *prev = NULL;
    for (ev_t *e = r->head; e; prev = e, e = e->next) {
        if (e->seq <= r->sent && is_connected()) continue;
        if (!strstr(e->json, "\"event\":\"output\"")) continue;
        if (prev) prev->next = e->next; else r->head = e->next;
        if (r->tail == e) r->tail = prev;
        r->bytes -= e->len;
        r->dropped += 1;
        free(e->json);
        free(e);
        return;
    }
}

/* Takes ownership of `body` (an object without type, id and seq). */
static void emit(run_t *r, json_t *body) {
    json_object_set_new(body, "type", json_string("run"));
    json_object_set_new(body, "id", json_string(r->id));
    long seq = r->next_seq + 1;
    json_object_set_new(body, "seq", json_integer(seq));
    char *text = json_dumps(body, JSON_COMPACT);
    json_decref(body);
    if (!text) return;
    r->next_seq = seq;

    ev_t *e = calloc(1, sizeof *e);
    if (!e) { free(text); return; }
    e->seq = seq;
    e->json = text;
    e->len = strlen(text);
    if (r->tail) r->tail->next = e; else r->head = e;
    r->tail = e;
    r->bytes += e->len;
    while (r->bytes > MAX_BUFFER_BYTES && r->head && r->head != e) drop_oldest_output(r);

    if (is_connected() && send_raw(text) == 0) r->sent = seq;
}

static void flush_pending(run_t *r) {
    if (!r->pending || json_array_size(r->pending) == 0) return;
    json_t *body = json_object();
    json_object_set_new(body, "event", json_string("output"));
    json_object_set_new(body, "script", json_string(r->cur < r->n_scripts ? r->scripts[r->cur] : ""));
    if (r->dropped) {
        char note[96];
        snprintf(note, sizeof note, "[agent] %ld output event(s) were dropped while offline", r->dropped);
        json_array_insert_new(r->pending, 0, json_string(note));
        r->dropped = 0;
    }
    json_object_set(body, "lines", r->pending);
    json_decref(r->pending);
    r->pending = NULL;
    emit(r, body);
}

/* Output must be valid UTF-8 to go into JSON: other bytes become '?'. */
static void sanitize_utf8(char *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        unsigned char c = (unsigned char)s[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        int ok = len > 0 && i + len <= n;
        for (size_t k = 1; ok && k < len; k++)
            if (((unsigned char)s[i + k] & 0xC0) != 0x80) ok = 0;
        if (c < 0x20 && c != '\t') { s[i] = ' '; i++; continue; }
        if (!ok) { s[i] = '?'; i++; continue; }
        i += len;
    }
}

static void add_line(run_t *r, size_t len) {
    r->line[len] = 0;
    if (len && r->line[len - 1] == '\r') r->line[--len] = 0;
    sanitize_utf8(r->line, len);
    if (!r->pending) {
        r->pending = json_array();
        r->pending_since = now_s();
    }
    json_array_append_new(r->pending, json_string(r->line));
    r->linelen = 0;
    if ((int)json_array_size(r->pending) >= BATCH_LINES) flush_pending(r);
}

static void feed_output(run_t *r, const char *buf, ssize_t n) {
    for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == '\n') add_line(r, r->linelen);
        else {
            r->line[r->linelen++] = buf[i];
            if (r->linelen >= MAX_LINE) add_line(r, r->linelen);
        }
    }
}

/* ---- the end of a test ---- */

static void finish(run_t *r, const char *status, const char *error) {
    if (r->finished) return;
    if (r->linelen) add_line(r, r->linelen);
    flush_pending(r);
    json_t *body = json_object();
    json_object_set_new(body, "event", json_string("finished"));
    json_object_set_new(body, "status", json_string(status));
    if (error) json_object_set_new(body, "error", json_string(error));
    emit(r, body);
    r->finished = 1;
    for (int i = 0; i < r->n_scripts; i++) { free(r->scripts[i]); r->scripts[i] = NULL; }
    r->n_scripts = 0;
}

static void begin_stop(run_t *r, const char *final_status) {
    if (r->finished || r->stopping) return;
    r->stopping = 1;
    r->final_status = final_status;
    if (r->pid > 0) {
        kill(-r->pid, SIGTERM);
        r->kill_at = now_s() + STOP_GRACE_SECONDS;
    } else {
        finish(r, final_status, !strcmp(final_status, "lost") ? "lost connection to the server" : NULL);
    }
}

/* ---- scripts ---- */

static void apply_env(run_t *r) {
    const char *key;
    json_t *value;
    json_object_foreach(r->env, key, value) {
        if (strncmp(key, "XCALE_", 6) || !json_is_string(value)) continue;
        int ok = 1;
        for (const char *p = key; *p; p++)
            if (!((*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '_')) ok = 0;
        if (ok) setenv(key, json_string_value(value), 1);
    }
    setenv("XCALE_ROOT", root_dir, 1);
}

static void start_script(run_t *r) {
    const char *rel = r->scripts[r->cur];
    char full[1024];
    struct stat st;
    snprintf(full, sizeof full, "%s/%s", root_dir, rel);
    if (stat(full, &st) != 0 || !S_ISREG(st.st_mode)) {
        char err[400];
        snprintf(err, sizeof err, "script not found on the node: %s (is the directory synced?)", rel);
        finish(r, "failed", err);
        return;
    }
    int fds[2];
    if (pipe(fds) != 0) { finish(r, "failed", "cannot create a pipe"); return; }

    pid_t pid = fork();
    if (pid < 0) {
        close(fds[0]); close(fds[1]);
        finish(r, "failed", "cannot start the script (fork failed)");
        return;
    }
    if (pid == 0) {
        setsid(); /* own process group: Stop reaches the children of the script too */
        signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0) { dup2(devnull, 0); close(devnull); }
        dup2(fds[1], 1); dup2(fds[1], 2);
        close(fds[0]); close(fds[1]);
        if (chdir(root_dir) != 0) _exit(126);
        apply_env(r);
        char path[1024];
        snprintf(path, sizeof path, "./%s", rel);
        execl("/bin/bash", "bash", path, (char *)NULL);
        _exit(127);
    }
    close(fds[1]);
    fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK);
    r->pid = pid;
    r->fd = fds[0];
    r->linelen = 0;
    json_t *body = json_object();
    json_object_set_new(body, "event", json_string("script_start"));
    json_object_set_new(body, "script", json_string(rel));
    emit(r, body);
}

static void drain(run_t *r) {
    char buf[4096];
    while (r->fd >= 0) {
        ssize_t n = read(r->fd, buf, sizeof buf);
        if (n > 0) feed_output(r, buf, n);
        else if (n == 0) { close(r->fd); r->fd = -1; }
        else break; /* EAGAIN */
    }
}

static void script_exited(run_t *r, int status) {
    drain(r);
    if (r->fd >= 0) { close(r->fd); r->fd = -1; }
    if (r->linelen) add_line(r, r->linelen);
    flush_pending(r);
    kill(-r->pid, SIGKILL); /* nothing a script left running in the background stays */
    int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    json_t *body = json_object();
    json_object_set_new(body, "event", json_string("script_exit"));
    json_object_set_new(body, "script", json_string(r->scripts[r->cur] ? r->scripts[r->cur] : ""));
    json_object_set_new(body, "code", json_integer(code));
    emit(r, body);
    r->pid = 0;

    if (r->forgotten) { r->finished = 1; return; }
    if (r->stopping) {
        finish(r, r->final_status, !strcmp(r->final_status, "lost") ? "lost connection to the server" : NULL);
    } else if (code != 0) {
        finish(r, "failed", NULL);
    } else if (++r->cur >= r->n_scripts) {
        r->cur = r->n_scripts - 1;
        finish(r, "passed", NULL);
    } else {
        start_script(r);
    }
}

/* ---- commands from the server ---- */

void run_handle_run(json_t *msg) {
    const char *id = json_string_value(json_object_get(msg, "id"));
    json_t *scripts = json_object_get(msg, "scripts");
    if (!id || !*id || strlen(id) >= sizeof runs[0].id || !json_is_array(scripts)) return;
    if (find_run(id)) return; /* already known, e.g. a repeated command */

    run_t *r = NULL;
    for (int i = 0; i < MAX_RUNS && !r; i++)
        if (!runs[i].used) r = &runs[i];
    int refuse = !r || has_active_run() || json_array_size(scripts) == 0 || json_array_size(scripts) > MAX_SCRIPTS;
    const char *why = !r || has_active_run() ? "the agent is busy with another test" : "bad list of scripts";
    for (size_t i = 0; !refuse && i < json_array_size(scripts); i++) {
        const char *s = json_string_value(json_array_get(scripts, i));
        if (!s || !safe_rel(s)) { refuse = 1; why = "bad script path"; }
    }
    if (refuse) {
        /* answer with a finished event of a run slot-less test: seq 1 is enough for the server */
        json_t *e = json_object();
        json_object_set_new(e, "type", json_string("run"));
        json_object_set_new(e, "id", json_string(id));
        json_object_set_new(e, "seq", json_integer(1));
        json_object_set_new(e, "event", json_string("finished"));
        json_object_set_new(e, "status", json_string("failed"));
        json_object_set_new(e, "error", json_string(why));
        send_json(e);
        json_decref(e);
        return;
    }

    memset(r, 0, sizeof *r);
    r->used = 1;
    r->fd = -1;
    snprintf(r->id, sizeof r->id, "%s", id);
    for (size_t i = 0; i < json_array_size(scripts); i++)
        r->scripts[r->n_scripts++] = strdup(json_string_value(json_array_get(scripts, i)));
    json_t *env = json_object_get(msg, "env");
    r->env = json_is_object(env) ? json_incref(env) : json_object();
    log_msg("test %s: %d script(s)", r->id, r->n_scripts);
    start_script(r);
}

void run_handle_stop(json_t *msg) {
    run_t *r = find_run(json_string_value(json_object_get(msg, "id")));
    if (r) begin_stop(r, "stopped");
}

void run_handle_ack(json_t *msg) {
    run_t *r = find_run(json_string_value(json_object_get(msg, "id")));
    json_t *seq = json_object_get(msg, "seq");
    if (!r || !json_is_integer(seq)) return;
    long acked = (long)json_integer_value(seq);
    if (acked > r->acked) r->acked = acked;
    while (r->head && r->head->seq <= r->acked) {
        ev_t *e = r->head;
        r->head = e->next;
        if (!r->head) r->tail = NULL;
        r->bytes -= e->len;
        free(e->json);
        free(e);
    }
    if (r->finished && !r->head) release(r);
}

void run_handle_forget(json_t *msg) {
    run_t *r = find_run(json_string_value(json_object_get(msg, "id")));
    if (!r) return;
    if (r->pid > 0 && !r->finished) {
        r->forgotten = 1; /* stop it and drop everything without reporting */
        queue_free(r);
        r->stopping = 1;
        kill(-r->pid, SIGTERM);
        r->kill_at = now_s() + STOP_GRACE_SECONDS;
    } else {
        release(r);
    }
}

json_t *run_hello_runs(void) {
    json_t *arr = json_array();
    for (int i = 0; i < MAX_RUNS; i++) {
        if (!runs[i].used || runs[i].forgotten) continue;
        json_t *o = json_object();
        json_object_set_new(o, "id", json_string(runs[i].id));
        json_object_set_new(o, "seq", json_integer(runs[i].next_seq));
        json_array_append_new(arr, o);
    }
    return arr;
}

void run_on_connected(void) {
    for (int i = 0; i < MAX_RUNS; i++) {
        run_t *r = &runs[i];
        if (!r->used) continue;
        r->lost_at = 0;
        r->sent = r->acked;
        /* the server drops events it already has, so resending is harmless */
        for (ev_t *e = r->head; e; e = e->next)
            if (e->seq > r->acked && send_raw(e->json) == 0) r->sent = e->seq;
    }
}

void run_on_disconnected(void) {
    for (int i = 0; i < MAX_RUNS; i++)
        /* only the first loss counts: failed reconnect attempts call this again */
        if (runs[i].used && !runs[i].finished && !runs[i].forgotten && runs[i].lost_at == 0)
            runs[i].lost_at = now_s() + grace_seconds();
}

int run_needs_server(void) {
    for (int i = 0; i < MAX_RUNS; i++)
        if (runs[i].used && !runs[i].forgotten) return 1;
    return 0;
}

int run_poll_fd(void) {
    for (int i = 0; i < MAX_RUNS; i++)
        if (runs[i].used && runs[i].fd >= 0) return runs[i].fd;
    return -1;
}

void run_pump(void) {
    double now = now_s();
    for (int i = 0; i < MAX_RUNS; i++) {
        run_t *r = &runs[i];
        if (!r->used) continue;
        if (r->fd >= 0) drain(r);
        if (r->pid > 0) {
            int status;
            if (waitpid(r->pid, &status, WNOHANG) == r->pid) script_exited(r, status);
            else if (r->stopping && now >= r->kill_at) kill(-r->pid, SIGKILL);
        }
        if (r->used && r->pending && now - r->pending_since >= BATCH_SECONDS) flush_pending(r);
        if (r->used && !r->finished && r->lost_at > 0 && now >= r->lost_at) begin_stop(r, "lost");
        if (r->used && r->forgotten && r->pid == 0) release(r);
    }
}

void run_shutdown(void) {
    for (int i = 0; i < MAX_RUNS; i++)
        if (runs[i].used && runs[i].pid > 0) kill(-runs[i].pid, SIGKILL);
}
