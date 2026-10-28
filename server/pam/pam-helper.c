/*
 * xcale-pam: checks a username and password against a PAM service.
 *
 *   xcale-pam <service> [min_uid]       credentials on stdin: "user\npassword\n"
 *
 * Exit codes: 0 accepted, 1 rejected (bad password, locked or expired account,
 * uid below min_uid), 2 internal error. Nothing is written to stdout/stderr
 * about why a login was rejected.
 *
 * XCALE_PAM_CONFDIR makes PAM read <service> from that directory instead of
 * /etc/pam.d (used by the tests).
 */
#define _GNU_SOURCE
#include <pwd.h>
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_FIELD 256

struct creds {
    char user[MAX_FIELD];
    char pass[MAX_FIELD];
};

static int converse(int n, const struct pam_message **msg, struct pam_response **resp, void *data) {
    struct creds *c = data;
    struct pam_response *r = calloc((size_t)n, sizeof *r);
    if (!r) return PAM_BUF_ERR;
    for (int i = 0; i < n; i++) {
        switch (msg[i]->msg_style) {
        case PAM_PROMPT_ECHO_OFF: r[i].resp = strdup(c->pass); break;
        case PAM_PROMPT_ECHO_ON: r[i].resp = strdup(c->user); break;
        default: break; /* info and error texts are ignored */
        }
    }
    *resp = r;
    return PAM_SUCCESS;
}

static int read_field(char *out) {
    if (!fgets(out, MAX_FIELD, stdin)) return -1;
    size_t len = strcspn(out, "\n");
    if (out[len] != '\n') return -1; /* too long or unterminated */
    out[len] = 0;
    for (size_t i = 0; i < len; i++)
        if ((unsigned char)out[i] < 0x20 && out[i] != '\t') return -1; /* control characters */
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *service = argv[1];
    long min_uid = argc > 2 ? atol(argv[2]) : 1000;

    struct creds c;
    if (read_field(c.user) != 0 || read_field(c.pass) != 0) return 1;
    if (!c.user[0] || !c.pass[0]) return 1;

    struct pam_conv conv = { converse, &c };
    pam_handle_t *pamh = NULL;
    const char *confdir = getenv("XCALE_PAM_CONFDIR");
    int rc = confdir ? pam_start_confdir(service, c.user, &conv, confdir, &pamh)
                     : pam_start(service, c.user, &conv, &pamh);
    if (rc != PAM_SUCCESS) return 2;

    rc = pam_authenticate(pamh, PAM_DISALLOW_NULL_AUTHTOK);
    if (rc == PAM_SUCCESS) rc = pam_acct_mgmt(pamh, PAM_DISALLOW_NULL_AUTHTOK);

    int code = 1;
    if (rc == PAM_SUCCESS) {
        struct passwd *pw = getpwnam(c.user);
        code = (pw && (long)pw->pw_uid >= min_uid) ? 0 : 1; /* never root or system accounts */
    } else if (rc == PAM_BUF_ERR || rc == PAM_ABORT || rc == PAM_SERVICE_ERR) {
        /* broken PAM configuration or out of memory; any other failure is a rejected login */
        code = 2;
    }
    pam_end(pamh, rc);
    explicit_bzero(&c, sizeof c);
    return code;
}
