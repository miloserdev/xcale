/*
 * Sensors of this node.
 *
 * Hardware sensors come from libsensors, like in the powerlog tool (plv3): every input
 * subfeature of every chip is a sensor named "<chip>_<bus>x<addr>_<subfeature>", for
 * example apm_xgene_0x0_power1_input. Labels and scaling honor sensors.conf. Which sensors
 * exist differs from machine to machine, nothing here is fixed in advance.
 *
 * Not hardware sensors but useful in every test: the load average and the CPU frequency
 * (cpufreq: average, lowest and highest core). libsensors does not provide them.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <sensors/error.h>
#include <sensors/sensors.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "agent.h"

#define MAX_SENSORS 1024
#define MAX_CPUS 1024

typedef enum { SRC_LIB, SRC_LOAD, SRC_FREQ } src_t;

typedef struct {
    char id[128];
    char label[128];
    char kind[24];
    char unit[12];
    src_t src;
    const sensors_chip_name *chip;
    int sub;   /* libsensors subfeature number */
    int field; /* load average column, or 0 avg / 1 min / 2 max for the frequency */
} sensor_t;

static sensor_t list[MAX_SENSORS];
static int count;
static int lib_ready;
static char *cpu_freq_path[MAX_CPUS];
static int n_cpus;

int sensors_count(void) { return count; }

void sensors_describe(int i, const char **id, const char **label, const char **kind, const char **unit) {
    *id = list[i].id;
    *label = list[i].label;
    *kind = list[i].kind;
    *unit = list[i].unit;
}

static int id_taken(const char *id) {
    for (int i = 0; i < count; i++)
        if (!strcmp(list[i].id, id)) return 1;
    return 0;
}

static sensor_t *add(const char *id, const char *label, const char *kind, const char *unit, src_t src) {
    if (count >= MAX_SENSORS) return NULL;
    char unique[128];
    snprintf(unique, sizeof unique, "%s", id);
    for (int i = 2; id_taken(unique); i++) snprintf(unique, sizeof unique, "%s#%d", id, i);
    sensor_t *s = &list[count++];
    memset(s, 0, sizeof *s);
    snprintf(s->id, sizeof s->id, "%s", unique);
    snprintf(s->label, sizeof s->label, "%s", label);
    snprintf(s->kind, sizeof s->kind, "%s", kind);
    snprintf(s->unit, sizeof s->unit, "%s", unit);
    s->src = src;
    return s;
}

/* The live value of a subfeature type: its kind and unit, or 0 for thresholds, alarms,
 * flags and other things that are not a reading. */
static int classify(int type, const char **kind, const char **unit) {
    switch (type) {
    case SENSORS_SUBFEATURE_TEMP_INPUT: *kind = "temperature"; *unit = "\xC2\xB0" "C"; return 1;
    case SENSORS_SUBFEATURE_FAN_INPUT: *kind = "fan"; *unit = "rpm"; return 1;
    case SENSORS_SUBFEATURE_POWER_INPUT:
    case SENSORS_SUBFEATURE_POWER_AVERAGE: *kind = "power"; *unit = "W"; return 1;
    case SENSORS_SUBFEATURE_IN_INPUT:
    case SENSORS_SUBFEATURE_IN_AVERAGE: *kind = "voltage"; *unit = "V"; return 1;
    case SENSORS_SUBFEATURE_CURR_INPUT: *kind = "current"; *unit = "A"; return 1;
    case SENSORS_SUBFEATURE_ENERGY_INPUT: *kind = "energy"; *unit = "J"; return 1;
    case SENSORS_SUBFEATURE_HUMIDITY_INPUT: *kind = "humidity"; *unit = "%"; return 1;
    default: return 0;
    }
}

static void discover_libsensors(const char *conf_path) {
    FILE *conf = NULL;
    if (conf_path) {
        conf = fopen(conf_path, "r");
        if (!conf) { log_msg("cannot open the sensors configuration %s", conf_path); return; }
    }
    int rc = sensors_init(conf);
    if (conf) fclose(conf);
    if (rc != 0) { log_msg("libsensors: %s", sensors_strerror(rc)); return; }
    lib_ready = 1;

    const sensors_chip_name *chip;
    int chip_nr = 0;
    while ((chip = sensors_get_detected_chips(NULL, &chip_nr)) != NULL) {
        const sensors_feature *feat;
        int feat_nr = 0;
        while ((feat = sensors_get_features(chip, &feat_nr)) != NULL) {
            char *label = sensors_get_label(chip, feat);
            const sensors_subfeature *sub;
            int sub_nr = 0;
            while ((sub = sensors_get_all_subfeatures(chip, feat, &sub_nr)) != NULL) {
                const char *kind, *unit;
                double value;
                if (!classify(sub->type, &kind, &unit)) continue;
                if (sensors_get_value(chip, sub->number, &value) != 0) continue;
                char id[128];
                snprintf(id, sizeof id, "%s_%dx%x_%s", chip->prefix, chip->bus.nr, chip->addr, sub->name);
                sensor_t *s = add(id, label ? label : feat->name, kind, unit, SRC_LIB);
                if (s) { s->chip = chip; s->sub = sub->number; }
            }
            free(label);
        }
    }
}

static void discover_system(void) {
    char buf[64];
    if (read_str("/proc/loadavg", buf, sizeof buf) == 0) {
        static const char *ids[] = { "system/load1", "system/load5", "system/load15" };
        static const char *labels[] = { "Load average (1 min)", "Load average (5 min)", "Load average (15 min)" };
        for (int i = 0; i < 3; i++) {
            sensor_t *s = add(ids[i], labels[i], "load", "", SRC_LOAD);
            if (s) s->field = i;
        }
    }

    /* the current frequency of every core: cpuinfo_cur_freq needs root, scaling_cur_freq not */
    DIR *d = opendir("/sys/devices/system/cpu");
    struct dirent *e;
    while (d && (e = readdir(d)) && n_cpus < MAX_CPUS) {
        int cpu;
        if (sscanf(e->d_name, "cpu%d", &cpu) != 1 || strchr(e->d_name + 3, 'f')) continue;
        char path[600];
        snprintf(path, sizeof path, "/sys/devices/system/cpu/%s/cpufreq/cpuinfo_cur_freq", e->d_name);
        if (read_str(path, buf, sizeof buf) != 0)
            snprintf(path, sizeof path, "/sys/devices/system/cpu/%s/cpufreq/scaling_cur_freq", e->d_name);
        if (read_str(path, buf, sizeof buf) == 0) cpu_freq_path[n_cpus++] = strdup(path);
    }
    if (d) closedir(d);
    if (n_cpus) {
        static const char *names[] = { "avg", "min", "max" };
        static const char *labels[] = { "CPU frequency (average)", "CPU frequency (lowest core)", "CPU frequency (highest core)" };
        for (int i = 0; i < 3; i++) {
            char id[40];
            snprintf(id, sizeof id, "cpufreq/%s", names[i]);
            sensor_t *s = add(id, labels[i], "frequency", "MHz", SRC_FREQ);
            if (s) s->field = i;
        }
    }
}

void sensors_discover(const char *conf_path) {
    discover_libsensors(conf_path);
    discover_system();
}

static int read_frequencies(double out[3]) {
    double sum = 0, lo = 1e18, hi = 0;
    int n = 0;
    char buf[64];
    for (int i = 0; i < n_cpus; i++) {
        if (read_str(cpu_freq_path[i], buf, sizeof buf) != 0) continue;
        double mhz = atof(buf) / 1000.0; /* kHz */
        sum += mhz;
        if (mhz < lo) lo = mhz;
        if (mhz > hi) hi = mhz;
        n++;
    }
    if (!n) return -1;
    out[0] = sum / n; out[1] = lo; out[2] = hi;
    return 0;
}

/* Reads all sensors at once: ok[i] says whether values[i] is valid. */
void sensors_read_all(double *values, int *ok) {
    double freq[3];
    int have_freq = 0, tried_freq = 0;
    for (int i = 0; i < count; i++) {
        sensor_t *s = &list[i];
        ok[i] = 0;
        if (s->src == SRC_LIB) {
            ok[i] = sensors_get_value(s->chip, s->sub, &values[i]) == 0;
        } else if (s->src == SRC_LOAD) {
            char buf[64];
            double v[3];
            if (read_str("/proc/loadavg", buf, sizeof buf) == 0 && sscanf(buf, "%lf %lf %lf", &v[0], &v[1], &v[2]) == 3) {
                values[i] = v[s->field];
                ok[i] = 1;
            }
        } else {
            if (!tried_freq) { have_freq = read_frequencies(freq) == 0; tried_freq = 1; }
            if (have_freq) { values[i] = freq[s->field]; ok[i] = 1; }
        }
    }
}

void sensors_shutdown(void) {
    if (lib_ready) sensors_cleanup();
    lib_ready = 0;
}
