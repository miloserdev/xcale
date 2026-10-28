import type { Store, TestRow } from "./db.ts"
import type { SensorInfo } from "./protocol.ts"

// Demo tests with synthetic sensor history, so the web UI has something to show without agents.

// Sensors in the naming of libsensors ("<chip>_<bus>x<addr>_<subfeature>"), like a two-socket
// Ampere Altra machine; the set differs between machines, so a fan exists on some only.
const chip = (n: number) => `apm_xgene_0x${n}`
const sensors: SensorInfo[] = [
  ...[0, 1].flatMap((n): SensorInfo[] => [
    { id: `${chip(n)}_temp1_input`, kind: "temperature", label: `CPU ${n} temperature`, unit: "°C" },
    { id: `${chip(n)}_power1_input`, kind: "power", label: `CPU ${n} cores`, unit: "W" },
    { id: `${chip(n)}_power2_input`, kind: "power", label: `CPU ${n} SoC`, unit: "W" },
  ]),
  { id: "nvme_0x50100_temp1_input", kind: "temperature", label: "NVMe composite", unit: "°C" },
  { id: "cpufreq/avg", kind: "frequency", label: "CPU frequency (average)", unit: "MHz" },
  { id: "cpufreq/min", kind: "frequency", label: "CPU frequency (lowest core)", unit: "MHz" },
  { id: "cpufreq/max", kind: "frequency", label: "CPU frequency (highest core)", unit: "MHz" },
  { id: "system/load1", kind: "load", label: "Load average (1 min)", unit: "" },
  { id: "system/load5", kind: "load", label: "Load average (5 min)", unit: "" },
  { id: "system/load15", kind: "load", label: "Load average (15 min)", unit: "" },
]
const fan: SensorInfo = { id: "nct6775_0x290_fan1_input", kind: "fan", label: "Chassis fan", unit: "rpm" }
const hasFan = (nodeId: string) => nodeId.length % 2 === 0
const sensorsOf = (nodeId: string) => (hasFan(nodeId) ? [...sensors, fan] : sensors)

function seeded(seed: string) {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19)

type Demo = Omit<TestRow, "clusterId" | "startedAt" | "finishedAt" | "metrics"> & {
  cluster: string
  nodes: string[] // node names inside the cluster
  startedAgoMin: number
  durationMin?: number // finished tests only
  metrics?: TestRow["metrics"]
}

const demo: Demo[] = [
  {
    id: "t1", cluster: "thermal_stand_0", name: "Thermal soak 30m", status: "running",
    scriptsPaths: ["cpu_stress.sh", "collect.sh"],
    nodes: ["node-01", "node-02"], nodeIds: [],
    configs: { duration: "30m", ambient: "35°C", load: "100%" },
    startedAgoMin: 12, startedBy: "max", result: null,
  },
  {
    id: "t2", cluster: "thermal_stand_0", name: "Fan curve sweep", status: "queued",
    scriptsPaths: ["fan_sweep.sh"], nodes: ["node-02"], nodeIds: [],
    configs: { step: "10%", hold: "60s" }, metrics: ["fan", "temperature"],
    startedAgoMin: -20, startedBy: "max", result: null,
  },
  {
    id: "t3", cluster: "thermal_stand_0", name: "CPU stress", status: "passed",
    scriptsPaths: ["cpu_stress.sh"], nodes: ["node-01"], nodeIds: [],
    configs: { duration: "15m", load: "100%" },
    startedAgoMin: 17 * 60, durationMin: 15, startedBy: "max",
    result: { maxTemp: 81, maxPower: 118 },
  },
  {
    id: "t4", cluster: "thermal_stand_0", name: "Power cap 300W", status: "failed",
    scriptsPaths: ["power_cap.sh"], nodes: ["node-03"], nodeIds: [],
    configs: { cap: "300W", duration: "10m" },
    startedAgoMin: 21 * 60, durationMin: 3, startedBy: "anna",
    result: { maxTemp: 92, maxPower: 130 },
  },
  {
    id: "t5", cluster: "thermal_stand_1", name: "Idle baseline", status: "passed",
    scriptsPaths: ["idle.sh"], nodes: ["node-01", "node-02"], nodeIds: [],
    configs: { duration: "10m" },
    startedAgoMin: 2 * 24 * 60, durationMin: 10, startedBy: "max",
    result: { maxTemp: 41, maxPower: 34 },
  },
  {
    id: "t6", cluster: "thermal_stand_1", name: "Thermal soak 30m", status: "aborted",
    scriptsPaths: ["cpu_stress.sh"], nodes: ["node-02"], nodeIds: [],
    configs: { duration: "30m", ambient: "35°C" },
    startedAgoMin: 3 * 24 * 60, durationMin: 11, startedBy: "anna",
    result: { maxTemp: 74, maxPower: 111 },
  },
  {
    id: "t7", cluster: "gpu_cluster_a", name: "GPU burn fp16", status: "running",
    scriptsPaths: ["gpu_burn.sh"], nodes: ["gpu-a-02", "gpu-a-04"], nodeIds: [],
    configs: { precision: "fp16", duration: "20m" },
    startedAgoMin: 9, startedBy: "max", result: null,
  },
  {
    id: "t8", cluster: "gpu_cluster_a", name: "GPU power sweep", status: "passed",
    scriptsPaths: ["gpu_power.sh"], nodes: ["gpu-a-01"], nodeIds: [],
    configs: { caps: "200W..450W", step: "50W" },
    startedAgoMin: 23 * 60, durationMin: 25, startedBy: "max",
    result: { maxTemp: 79, maxPower: 109 },
  },
]

function logFor(t: TestRow, names: string[]) {
  const lines: { ts: number; line: string }[] = []
  const add = (ts: number, line: string) =>
    lines.push({ ts, line: `[${clock(ts)}] ${line}` })
  const end = t.finishedAt ?? Date.now()
  add(t.startedAt, `runner: test ${t.id} "${t.name}" started`)
  for (const n of names) add(t.startedAt + 1000, `${n} agent: connected, sensors ok`)
  for (const p of t.scriptsPaths) add(t.startedAt + 2000, `runner: exec ${p}`)
  for (let ts = t.startedAt + 3 * MIN; ts < end; ts += 3 * MIN)
    for (const n of names) add(ts, `${n} sensors: temp, fan, power sampled`)
  if (t.status === "failed") {
    add(end, `${names.at(-1)} ERROR: agent lost connection`)
    add(end + 1000, "runner: test failed")
  } else if (t.status === "aborted") {
    add(end, `runner: WARN abort requested by ${t.startedBy}`)
    add(end + 1000, "runner: test aborted")
  } else if (t.status === "passed") {
    add(end, "runner: all scripts finished, test passed")
  }
  return lines
}

export function seedDemo(store: Store) {
  const now = Date.now()
  const nodes = store.db
    .prepare("SELECT id, cluster_id, name FROM nodes")
    .all() as { id: string; cluster_id: string; name: string }[]

  nodes.forEach((s, i) => {
    store.setNodeDetails(
      s.id,
      {
        os: "Ubuntu 24.04 LTS",
        kernel: "6.8.0-45-generic",
        hostname: `${s.name}.lab.local`,
        cpu: "AMD EPYC 7543 32-Core Processor",
        threads: 64,
        memory_kb: 256 * 1024 * 1024,
        boot_ts: now - (3 + (i % 4)) * 24 * HOUR,
      },
      sensorsOf(s.id)
    )
  })

  // Re-running replaces the demo history instead of duplicating it.
  const demoIds = [...new Set(demo.flatMap((d) => d.nodes.map((n) => `${d.cluster}.${n}`)))]
  store.db
    .prepare(`DELETE FROM samples WHERE node_id IN (${demoIds.map(() => "?").join(",")})`)
    .run(...demoIds)

  for (const d of demo) {
    const ids = d.nodes.map((n) => `${d.cluster}.${n}`)
    const startedAt = now - d.startedAgoMin * MIN
    const finishedAt = d.durationMin ? startedAt + d.durationMin * MIN : null
    const test: TestRow = {
      ...d,
      clusterId: d.cluster,
      nodeIds: ids,
      startedAt,
      finishedAt,
      metrics: [],
    }
    store.createTest(test, logFor(test, d.nodes))

    if (d.status === "queued") continue
    const rand = seeded(d.id)
    const end = finishedAt ?? now
    const total = Math.max(1, (end - startedAt) / MIN)
    const maxTemp = d.result?.maxTemp ?? 76
    const maxPower = d.result?.maxPower ?? 110
    ids.forEach((id, si) => {
      const offset = (si - (ids.length - 1) / 2) * 2
      for (let ts = startedAt; ts <= end; ts += 30_000) {
        const ramp = 1 - Math.exp(-((ts - startedAt) / MIN + 1) / (total / 3))
        const noise = () => (rand() - 0.5) * 2
        const load = 1 + 60 * ramp + offset * 0.5
        const values: Record<string, number> = {
          "nvme_0x50100_temp1_input": 38 + 14 * ramp + noise() * 0.5,
          "cpufreq/avg": 3000 - 500 * ramp + noise() * 15,
          "cpufreq/min": 1000 + 1500 * (1 - ramp) + noise() * 20,
          "cpufreq/max": 3000 - 150 * ramp + noise() * 10,
          "system/load1": load + noise(),
          "system/load5": load - 2 + noise() * 0.3,
          "system/load15": load - 5 + noise() * 0.1,
        }
        for (const n of [0, 1]) {
          const skew = n === 0 ? 1 : 0.8
          values[`${chip(n)}_temp1_input`] = 38 + (maxTemp - 38) * ramp * skew + offset + noise()
          values[`${chip(n)}_power1_input`] = 15 + (maxPower - 15) * ramp * skew + offset + noise() * 1.5
          values[`${chip(n)}_power2_input`] = 8 + 3 * ramp * skew + noise() * 0.3
        }
        if (hasFan(id)) values[fan.id] = 3000 + 5000 * ramp + offset * 80 + noise() * 120
        store.insertSamples(id, ts, values)
      }
    })
  }
}
