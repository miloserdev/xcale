/*
 * Copying the scripts directory of the cluster from the server to this node.
 *
 * The server sends the manifest (path, size, sha256, mode of every file). The agent
 * compares it with what is in the root directory, removes files that are not in the
 * manifest, asks for the missing or changed ones and writes them atomically (a temporary
 * file, then rename). It answers with `sync_done` or `sync_failed` plus a description.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include "agent.h"

#define MAX_FILES 2000
#define MAX_FILE_BYTES (5L * 1024 * 1024)
#define MARKER ".xcale-managed"

typedef struct {
    char path[300];
    long size;
    char sha[65];
    int mode;
    int need;
    int done;
} mf_t;

static struct {
    int active;
    char id[64];
    char version[64];
    mf_t *files;
    int n;
    int need_total, need_done;
    int cur; /* index of the file being received, -1 */
    int fd;
    char tmp[1100];
    EVP_MD_CTX *md;
    long written;
} S = { .cur = -1, .fd = -1 };

/* ---- helpers ---- */

int safe_rel(const char *p) {
    if (!p || !*p || strlen(p) >= 300 || p[0] == '/') return 0;
    int depth = 0;
    const char *s = p;
    while (*s) {
        const char *e = strchr(s, '/');
        size_t len = e ? (size_t)(e - s) : strlen(s);
        if (len == 0 || len > 100 || ++depth > 8) return 0;
        for (size_t i = 0; i < len; i++) {
            char c = s[i];
            int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                     c == '_' || (i > 0 && (c == '.' || c == '-'));
            if (!ok) return 0;
        }
        if (!e) break;
        s = e + 1;
    }
    return 1;
}

static void hex(const unsigned char *d, unsigned n, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (unsigned i = 0; i < n; i++) { out[2 * i] = digits[d[i] >> 4]; out[2 * i + 1] = digits[d[i] & 15]; }
    out[2 * n] = 0;
}

static int sha_of_file(const char *path, char out[65], long *size) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return -1;
    EVP_MD_CTX *md = EVP_MD_CTX_new();
    EVP_DigestInit_ex(md, EVP_sha256(), NULL);
    unsigned char buf[65536];
    ssize_t n;
    long total = 0;
    while ((n = read(fd, buf, sizeof buf)) > 0) { EVP_DigestUpdate(md, buf, (size_t)n); total += n; }
    close(fd);
    unsigned char dg[EVP_MAX_MD_SIZE];
    unsigned len = 0;
    EVP_DigestFinal_ex(md, dg, &len);
    EVP_MD_CTX_free(md);
    if (n < 0) return -1;
    hex(dg, len, out);
    *size = total;
    return 0;
}

static int b64val(int c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

/* Decodes into out (large enough: 3/4 of the input); returns the length or -1. */
static long b64decode(const char *in, unsigned char *out) {
    long n = 0;
    int acc = 0, bits = 0;
    for (; *in && *in != '='; in++) {
        int v = b64val((unsigned char)*in);
        if (v < 0) return -1;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out[n++] = (unsigned char)((acc >> bits) & 0xFF); }
    }
    return n;
}

static void reply(const char *type, const char *key, const char *value) {
    json_t *m = json_object();
    json_object_set_new(m, "type", json_string(type));
    json_object_set_new(m, "id", json_string(S.id));
    if (key) json_object_set_new(m, key, json_string(value));
    send_json(m);
    json_decref(m);
}

static void cleanup(void) {
    if (S.fd >= 0) { close(S.fd); S.fd = -1; }
    if (S.tmp[0]) { unlink(S.tmp); S.tmp[0] = 0; }
    if (S.md) { EVP_MD_CTX_free(S.md); S.md = NULL; }
    free(S.files);
    S.files = NULL;
    S.n = 0;
    S.cur = -1;
    S.need_total = S.need_done = 0;
    S.written = 0;
    S.active = 0;
}

static void fail(const char *what, const char *detail) {
    char text[600];
    if (detail) snprintf(text, sizeof text, "%s: %s", what, detail);
    else snprintf(text, sizeof text, "%s", what);
    log_msg("sync failed: %s", text);
    reply("sync_failed", "error", text);
    cleanup();
}

void sync_abort(void) {
    if (S.active) cleanup();
}

/* ---- the directory on the node ---- */

static int root_is_sane(void) {
    /* a mistake like --root / must never delete files: at least two path components */
    int parts = 0;
    for (const char *p = root_dir; *p; p++)
        if (*p == '/' && p[1] && p[1] != '/') parts++;
    return root_dir[0] == '/' && parts >= 2;
}

static int mkdir_p(const char *path) {
    char tmp[1024];
    snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p != '/') continue;
        *p = 0;
        if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
        *p = '/';
    }
    return mkdir(tmp, 0755) != 0 && errno != EEXIST ? -1 : 0;
}

/* Creates the directories of a relative path under the root, never through a symlink. */
static int mkdirs_under_root(const char *rel_file) {
    char path[1024];
    snprintf(path, sizeof path, "%s", root_dir);
    size_t len = strlen(path);
    const char *s = rel_file;
    for (const char *e; (e = strchr(s, '/')); s = e + 1) {
        len += (size_t)snprintf(path + len, sizeof path - len, "/%.*s", (int)(e - s), s);
        struct stat st;
        if (lstat(path, &st) != 0) {
            if (mkdir(path, 0755) != 0) return -1;
        } else if (!S_ISDIR(st.st_mode)) {
            errno = S_ISLNK(st.st_mode) ? ELOOP : ENOTDIR;
            return -1;
        }
    }
    return 0;
}

static mf_t *find_file(const char *rel) {
    for (int i = 0; i < S.n; i++)
        if (!strcmp(S.files[i].path, rel)) return &S.files[i];
    return NULL;
}

static int dir_needed(const char *rel) {
    size_t len = strlen(rel);
    for (int i = 0; i < S.n; i++)
        if (!strncmp(S.files[i].path, rel, len) && S.files[i].path[len] == '/') return 1;
    return 0;
}

/* Removes everything under dir that is not in the manifest; returns -1 on an error. */
static int prune(const char *dir, const char *rel, int depth) {
    DIR *d = opendir(dir);
    if (!d) return -1;
    struct dirent *e;
    int rc = 0;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        if (!rel[0] && !strcmp(e->d_name, MARKER)) continue;
        char abs[1024], r[400];
        snprintf(abs, sizeof abs, "%s/%s", dir, e->d_name);
        snprintf(r, sizeof r, "%s%s%s", rel, rel[0] ? "/" : "", e->d_name);
        struct stat st;
        if (lstat(abs, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (depth < 8) prune(abs, r, depth + 1);
            if (!dir_needed(r)) rmdir(abs); /* only succeeds when empty */
        } else {
            mf_t *f = find_file(r);
            if (!f || S_ISLNK(st.st_mode)) {
                if (unlink(abs) != 0) rc = -1;
            }
        }
    }
    closedir(d);
    return rc;
}

static int dir_is_empty(const char *dir) {
    DIR *d = opendir(dir);
    if (!d) return 1;
    struct dirent *e;
    int empty = 1;
    while ((e = readdir(d)))
        if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) { empty = 0; break; }
    closedir(d);
    return empty;
}

/* ---- the sync message ---- */

void sync_handle_sync(json_t *msg) {
    if (S.active) cleanup();
    const char *id = json_string_value(json_object_get(msg, "id"));
    const char *version = json_string_value(json_object_get(msg, "version"));
    json_t *files = json_object_get(msg, "files");
    if (!id || !version || !json_is_array(files) || strlen(id) >= sizeof S.id || strlen(version) >= sizeof S.version) return;
    snprintf(S.id, sizeof S.id, "%s", id);
    snprintf(S.version, sizeof S.version, "%s", version);
    S.active = 1;
    S.cur = -1;
    S.fd = -1;

    size_t count = json_array_size(files);
    if (count > MAX_FILES) return fail("too many files in the manifest", NULL);
    S.files = calloc(count ? count : 1, sizeof(mf_t));
    if (!S.files) return fail("out of memory", NULL);
    for (size_t i = 0; i < count; i++) {
        json_t *f = json_array_get(files, i);
        const char *path = json_string_value(json_object_get(f, "path"));
        const char *sha = json_string_value(json_object_get(f, "sha256"));
        json_t *size = json_object_get(f, "size"), *mode = json_object_get(f, "mode");
        if (!path || !safe_rel(path) || !sha || strlen(sha) != 64 || !json_is_integer(size) ||
            json_integer_value(size) < 0 || json_integer_value(size) > MAX_FILE_BYTES)
            return fail("the manifest contains an invalid entry", path);
        mf_t *m = &S.files[S.n++];
        snprintf(m->path, sizeof m->path, "%s", path);
        snprintf(m->sha, sizeof m->sha, "%s", sha);
        m->size = (long)json_integer_value(size);
        m->mode = json_is_integer(mode) && (json_integer_value(mode) & 0100) ? 0755 : 0644;
    }

    if (!root_is_sane()) return fail("unsafe root directory", root_dir);
    if (mkdir_p(root_dir) != 0) {
        char d[300];
        snprintf(d, sizeof d, "%s: %s", root_dir, strerror(errno));
        return fail("cannot create the root directory", d);
    }
    if (access(root_dir, W_OK | X_OK) != 0) {
        char d[300];
        snprintf(d, sizeof d, "%s: %s", root_dir, strerror(errno));
        return fail("no write access to the root directory", d);
    }
    char marker[1100];
    snprintf(marker, sizeof marker, "%s/%s", root_dir, MARKER);
    if (access(marker, F_OK) != 0) {
        if (!dir_is_empty(root_dir))
            return fail("the directory is not empty and not managed by xcale, refusing to delete files", root_dir);
        int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0644);
        if (fd < 0) return fail("cannot write into the root directory", strerror(errno));
        close(fd);
    }

    if (prune(root_dir, "", 0) != 0) return fail("cannot remove an obsolete file", strerror(errno));

    json_t *need = json_array();
    for (int i = 0; i < S.n; i++) {
        mf_t *f = &S.files[i];
        char abs[1100], sha[65];
        long size = 0;
        snprintf(abs, sizeof abs, "%s/%s", root_dir, f->path);
        struct stat st;
        int same = lstat(abs, &st) == 0 && S_ISREG(st.st_mode) && sha_of_file(abs, sha, &size) == 0 &&
                   size == f->size && !strcmp(sha, f->sha);
        if (same) {
            if ((st.st_mode & 0777) != (mode_t)f->mode) chmod(abs, (mode_t)f->mode);
            f->done = 1;
        } else {
            f->need = 1;
            S.need_total++;
            json_array_append_new(need, json_string(f->path));
        }
    }
    log_msg("sync %s: %d file(s), %d to copy", S.version, S.n, S.need_total);
    if (S.need_total == 0) {
        json_decref(need);
        reply("sync_done", "version", S.version);
        cleanup();
        return;
    }
    json_t *m = json_object();
    json_object_set_new(m, "type", json_string("sync_need"));
    json_object_set_new(m, "id", json_string(S.id));
    json_object_set_new(m, "paths", need);
    send_json(m);
    json_decref(m);
}

/* ---- file chunks ---- */

static void file_done(mf_t *f) {
    unsigned char dg[EVP_MAX_MD_SIZE];
    unsigned len = 0;
    char sha[65], abs[1100];
    EVP_DigestFinal_ex(S.md, dg, &len);
    EVP_MD_CTX_free(S.md);
    S.md = NULL;
    hex(dg, len, sha);
    if (S.written != f->size || strcmp(sha, f->sha)) return fail("the received file does not match the manifest", f->path);
    if (fchmod(S.fd, (mode_t)f->mode) != 0) return fail("cannot set the mode of", f->path);
    if (close(S.fd) != 0) { S.fd = -1; return fail("cannot write", strerror(errno)); }
    S.fd = -1;
    snprintf(abs, sizeof abs, "%s/%s", root_dir, f->path);
    if (rename(S.tmp, abs) != 0) return fail("cannot put the file in place", strerror(errno));
    S.tmp[0] = 0;
    S.cur = -1;
    f->done = 1;
    if (++S.need_done == S.need_total) {
        log_msg("sync %s done", S.version);
        reply("sync_done", "version", S.version);
        cleanup();
    }
}

void sync_handle_file(json_t *msg) {
    if (!S.active) return;
    const char *id = json_string_value(json_object_get(msg, "id"));
    const char *path = json_string_value(json_object_get(msg, "path"));
    const char *data = json_string_value(json_object_get(msg, "data"));
    json_t *last = json_object_get(msg, "last");
    if (!id || strcmp(id, S.id) || !path || !data) return;

    mf_t *f = find_file(path);
    if (!f || !f->need || f->done) return fail("the server sent a file that was not requested", path);
    int idx = (int)(f - S.files);
    if (S.cur >= 0 && S.cur != idx) return fail("files arrived out of order", path);

    if (S.cur < 0) {
        if (mkdirs_under_root(f->path) != 0) return fail("cannot create a directory for", f->path);
        const char *slash = strrchr(f->path, '/');
        snprintf(S.tmp, sizeof S.tmp, "%s/%.*s%s.xcale-tmp-%s-%d", root_dir, slash ? (int)(slash - f->path + 1) : 0,
                 f->path, "", S.id, idx);
        S.fd = open(S.tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
        if (S.fd < 0) { S.tmp[0] = 0; return fail("cannot create a file", strerror(errno)); }
        S.md = EVP_MD_CTX_new();
        EVP_DigestInit_ex(S.md, EVP_sha256(), NULL);
        S.written = 0;
        S.cur = idx;
    }

    size_t in_len = strlen(data);
    unsigned char *buf = malloc(in_len / 4 * 3 + 4);
    if (!buf) return fail("out of memory", NULL);
    long n = b64decode(data, buf);
    if (n < 0) { free(buf); return fail("bad data for", f->path); }
    if (S.written + n > f->size) { free(buf); return fail("the file is larger than announced", f->path); }
    long off = 0;
    while (off < n) {
        ssize_t w = write(S.fd, buf + off, (size_t)(n - off));
        if (w < 0) {
            if (errno == EINTR) continue;
            free(buf);
            return fail("write failed", strerror(errno));
        }
        off += w;
    }
    EVP_DigestUpdate(S.md, buf, (size_t)n);
    S.written += n;
    free(buf);
    if (json_is_true(last)) file_done(f);
}
