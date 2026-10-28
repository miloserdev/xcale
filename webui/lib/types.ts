// Shapes returned by the xcale server REST API (see server/src/http.ts).

export type TestStatus = "queued" | "running" | "passed" | "failed" | "aborted"
// open set: temperature, fan, power, voltage, current, energy, frequency, load, ...
export type SensorKind = string

export type SensorInfo = {
  id: string
  kind: SensorKind
  label: string
  unit: string
}

export type MachineInfo = {
  os?: string
  kernel?: string
  hostname?: string
  cpu?: string
  threads?: number
  memory_kb?: number
  boot_ts?: number
}

export type ClusterSummary = {
  id: string
  name: string
  nodeCount: number
}

// Whether the scripts directory of a node matches the one of the cluster.
export type SyncStatus =
  "unknown" | "syncing" | "synced" | "outdated" | "failed"

export type ScriptFile = { path: string; size: number }
export type ScriptList = { version: string; files: ScriptFile[] }
export type ScriptContent = {
  path: string
  content: string
  sha256: string
  size: number
  executable: boolean
}

export type Node = {
  id: string
  name: string
  host: string
  online: boolean
  lastSeen: number | null
  agentVersion: string | null
  lastIp: string | null // as seen by the xcale server on the last connection
  lastMac: string | null
  group: string | null // the group of the node inside its cluster
  syncStatus: SyncStatus
  syncVersion: string | null
  syncError: string | null
  syncAt: number | null
  info: MachineInfo
  sensors: SensorInfo[]
}

// null when the test collected no data of that kind
export type TestResult = {
  maxTemp: number | null // °C
  maxPower: number | null // W
}

export type Test = {
  id: string
  name: string
  status: TestStatus
  scriptsPaths: string[]
  nodeIds: string[]
  configs: Record<string, string>
  startedAt: string // ISO
  durationMs: number | null
  startedBy: string
  result: TestResult | null
}

export type SeriesPoint = { t: number; time: string } & Record<
  string,
  number | string
>

// A sensor of a node; `key` is "<node id>|<sensor id>" and names its column in the series.
export type TestSensor = {
  key: string
  nodeId: string
  node: string
  id: string
  label: string
  kind: SensorKind
  unit: string
}

export type Telemetry = {
  nodes: { id: string; name: string }[]
  sensors: TestSensor[]
  series: Record<string, SeriesPoint[]> // by sensor kind
}

export type SensorStat = TestSensor & {
  min: number
  avg: number
  max: number
  samples: number
}

export type TestStats = {
  nodes: { id: string; name: string }[]
  sensors: SensorStat[]
}

// What deleting a cluster would remove.
export type ClusterStats = {
  id: string
  name: string
  nodes: number
  tests: number
  activeTests: number
}

// The overview of a cluster: only the most recent items, with totals for the "all" links.
export type Overview = {
  nodes: { total: number; online: number; items: Node[] }
  active: { total: number; items: Test[] }
  history: { total: number; items: Test[] }
}

export type LoadavgPoint = {
  t: number
  time: string
  load1?: number
  load5?: number
  load15?: number
}

export type LatestValue = SensorInfo & { value: number; ts: number }

// nodeId: the node a line belongs to, null for lines of the runner itself
export type LogLine = {
  id: number
  ts: number
  line: string
  nodeId: string | null
}

export type NodeStatus =
  "waiting" | "running" | "passed" | "failed" | "stopped" | "lost"

// How a test goes on one node.
export type NodeRun = {
  nodeId: string
  name: string
  status: NodeStatus
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}
