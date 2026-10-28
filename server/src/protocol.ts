// Agent <-> server protocol: JSON text frames over WebSocket (`/agent`).

// What a sensor measures, chosen by the agent: temperature, power, voltage, current, energy,
// fan, frequency, load, humidity, ... New kinds need no change here.
export type SensorKind = string

export type SensorInfo = {
  id: string // stable, e.g. "coretemp/temp1"
  kind: SensorKind
  label: string
  unit: string // "°C" | "rpm" | "W" | ""
}

// agent -> server
// Static machine description sent once in `hello`.
export type MachineInfo = {
  os?: string
  kernel?: string
  hostname?: string
  cpu?: string
  threads?: number
  memory_kb?: number
  boot_ts?: number // unix ms
}

// A test the agent still holds events for (running, or finished and not yet acknowledged).
export type HelloRun = { id: string; seq: number }

export type Hello = {
  type: "hello"
  node: string // "<cluster>.<node>"
  token: string
  version: string
  mac: string | null // of the interface the agent connected through
  root: string // directory on the node the scripts are copied to
  info: MachineInfo
  sensors: SensorInfo[]
  runs: HelloRun[]
}

export type Sample = {
  type: "sample"
  ts: number // unix ms
  values: Record<string, number> // sensor id -> value
}

// Syncing the scripts directory: the server sends the manifest, the agent answers with the
// files it lacks, the server sends them in chunks, the agent confirms (or fails).
export type SyncNeed = { type: "sync_need"; id: string; paths: string[] }
export type SyncDone = { type: "sync_done"; id: string; version: string }
export type SyncFailed = { type: "sync_failed"; id: string; error: string }

// Progress of a test on the node. `seq` numbers the events of one test so that the
// server can acknowledge them and the agent can resend after a lost connection.
export type RunStatus = "passed" | "failed" | "stopped" | "lost"
export type RunEvent = {
  type: "run"
  id: string // test id
  seq: number
  event: "script_start" | "output" | "script_exit" | "finished"
  script?: string
  lines?: string[]
  code?: number
  status?: RunStatus
  error?: string
}

// server -> agent
export type Welcome = { type: "welcome"; interval_ms: number }
export type ErrorMessage = { type: "error"; message: string }
export type SyncMessage = {
  type: "sync"
  id: string
  version: string
  files: { path: string; size: number; sha256: string; mode: number }[]
}
export type FileChunk = {
  type: "file"
  id: string // the sync id
  path: string
  last: boolean
  data: string // base64
}
export type RunCommand = {
  type: "run"
  id: string // test id
  scripts: string[]
  env: Record<string, string>
}
export type StopCommand = { type: "stop"; id: string }
export type RunAck = { type: "run_ack"; id: string; seq: number }
export type Forget = { type: "forget"; id: string }

const kindPattern = /^[a-z][a-z0-9_]{0,23}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseHello(data: unknown): Hello | string {
  if (!isRecord(data) || data.type !== "hello") return "expected hello"
  // agents older than the rename send the id as `server`
  const { token, version, sensors } = data
  const node = data.node ?? data.server
  if (typeof node !== "string" || !node) return "bad node"
  if (typeof token !== "string" || !token) return "bad token"
  if (typeof version !== "string") return "bad version"
  if (!Array.isArray(sensors) || sensors.length > 1000) return "bad sensors"
  const parsed: SensorInfo[] = []
  for (const s of sensors) {
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      !s.id ||
      s.id.length > 200 ||
      typeof s.kind !== "string" ||
      !kindPattern.test(s.kind) ||
      typeof s.label !== "string" ||
      s.label.length > 300 ||
      typeof s.unit !== "string" ||
      s.unit.length > 16
    ) {
      return "bad sensor"
    }
    parsed.push({
      id: s.id,
      kind: s.kind,
      label: s.label,
      unit: s.unit,
    })
  }
  const runs: HelloRun[] = []
  if (Array.isArray(data.runs)) {
    for (const r of data.runs.slice(0, 50)) {
      if (isRecord(r) && typeof r.id === "string" && Number.isInteger(r.seq) && (r.seq as number) >= 0)
        runs.push({ id: r.id, seq: r.seq as number })
    }
  }
  const mac =
    typeof data.mac === "string" && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(data.mac)
      ? data.mac.toLowerCase()
      : null
  const root = typeof data.root === "string" ? data.root.slice(0, 300) : ""
  return {
    type: "hello",
    node,
    token,
    version,
    mac,
    root,
    info: parseInfo(data.info),
    sensors: parsed,
    runs,
  }
}

export function parseSample(data: unknown): Sample | string {
  if (!isRecord(data) || data.type !== "sample") return "expected sample"
  if (typeof data.ts !== "number" || !Number.isFinite(data.ts)) return "bad ts"
  if (!isRecord(data.values)) return "bad values"
  const values: Record<string, number> = {}
  for (const [id, v] of Object.entries(data.values)) {
    if (typeof v === "number" && Number.isFinite(v)) values[id] = v
  }
  return { type: "sample", ts: data.ts, values }
}

function parseInfo(data: unknown): MachineInfo {
  if (!isRecord(data)) return {}
  const info: MachineInfo = {}
  for (const key of ["os", "kernel", "hostname", "cpu"] as const) {
    const v = data[key]
    if (typeof v === "string") info[key] = v.slice(0, 200)
  }
  for (const key of ["threads", "memory_kb", "boot_ts"] as const) {
    const v = data[key]
    if (typeof v === "number" && Number.isFinite(v)) info[key] = v
  }
  return info
}

// Messages of a connected agent other than `hello` and `sample`; a string describes the problem.
export function parseAgentMessage(
  data: unknown
): SyncNeed | SyncDone | SyncFailed | RunEvent | string {
  if (!isRecord(data) || typeof data.type !== "string") return "bad message"
  const str = (v: unknown, max = 1000) => (typeof v === "string" && v.length <= max ? v : null)

  if (data.type === "sync_need") {
    const id = str(data.id, 100)
    if (!id || !Array.isArray(data.paths) || data.paths.length > 5000) return "bad sync_need"
    const paths = data.paths.filter((p): p is string => typeof p === "string" && p.length <= 300)
    return { type: "sync_need", id, paths }
  }
  if (data.type === "sync_done") {
    const id = str(data.id, 100)
    const version = str(data.version, 100)
    return id && version ? { type: "sync_done", id, version } : "bad sync_done"
  }
  if (data.type === "sync_failed") {
    const id = str(data.id, 100)
    const error = str(data.error, 500) ?? "unknown error"
    return id ? { type: "sync_failed", id, error } : "bad sync_failed"
  }
  if (data.type === "run") {
    const id = str(data.id, 100)
    const event = data.event
    if (!id || !Number.isInteger(data.seq) || (data.seq as number) < 1) return "bad run event"
    if (event !== "script_start" && event !== "output" && event !== "script_exit" && event !== "finished")
      return "bad run event"
    const lines = Array.isArray(data.lines)
      ? data.lines.slice(0, 500).filter((l): l is string => typeof l === "string").map((l) => l.slice(0, 4000))
      : undefined
    const status = data.status
    return {
      type: "run",
      id,
      seq: data.seq as number,
      event,
      script: str(data.script, 300) ?? undefined,
      lines,
      code: Number.isInteger(data.code) ? (data.code as number) : undefined,
      status:
        status === "passed" || status === "failed" || status === "stopped" || status === "lost"
          ? status
          : undefined,
      error: str(data.error, 500) ?? undefined,
    }
  }
  return "unknown message type"
}
