import type { SensorStat, Store, TestRow } from "./db.ts"

// What the web UI and the export need from the sensor history of a test.
// A sensor of a node is identified by `key` = "<node id>|<sensor id>".
export type SensorRef = {
  key: string
  nodeId: string
  node: string
  id: string
  label: string
  kind: string
  unit: string
}

export const sensorKey = (nodeId: string, sensorId: string) => `${nodeId}|${sensorId}`

// Every sensor the nodes announced; a reading of a sensor that is no longer announced
// still gets an entry (kind "other") so that no data is lost.
export function sensorRefs(store: Store, nodeIds: string[]) {
  const refs = new Map<string, SensorRef>()
  for (const nodeId of nodeIds) {
    const info = store.getNode(nodeId)
    for (const s of info?.sensors ?? []) {
      const key = sensorKey(nodeId, s.id)
      refs.set(key, {
        key,
        nodeId,
        node: info?.name ?? nodeId,
        id: s.id,
        label: s.label,
        kind: s.kind,
        unit: s.unit,
      })
    }
  }
  return refs
}

function refFor(refs: Map<string, SensorRef>, store: Store, nodeId: string, sensorId: string) {
  const key = sensorKey(nodeId, sensorId)
  let ref = refs.get(key)
  if (!ref) {
    ref = {
      key,
      nodeId,
      node: store.getNode(nodeId)?.name ?? nodeId,
      id: sensorId,
      label: sensorId,
      kind: "other",
      unit: "",
    }
    refs.set(key, ref)
  }
  return ref
}

const windowOf = (test: TestRow): [number, number] => [test.startedAt, test.finishedAt ?? Date.now()]
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const nodesOf = (store: Store, test: TestRow) =>
  test.nodeIds.map((id) => ({ id, name: store.getNode(id)?.name ?? id }))

export type SeriesPoint = { t: number; time: string } & Record<string, number | string>

// One line per sensor, grouped by kind; every value is the average of a time bucket.
export function testTelemetry(store: Store, test: TestRow, bucketMs: number) {
  const refs = sensorRefs(store, test.nodeIds)
  const [from, to] = windowOf(test)
  const used = new Map<string, SensorRef>()
  const byKind = new Map<string, Map<number, SeriesPoint>>()

  for (const row of store.bucketedSamples(test.nodeIds, from, to, bucketMs)) {
    const ref = refFor(refs, store, row.node_id, row.sensor)
    used.set(ref.key, ref)
    const points = byKind.get(ref.kind) ?? new Map<number, SeriesPoint>()
    byKind.set(ref.kind, points)
    const point = points.get(row.bucket) ?? { t: row.bucket, time: hhmm(row.bucket) }
    point[ref.key] = +row.value.toFixed(4)
    points.set(row.bucket, point)
  }

  const series: Record<string, SeriesPoint[]> = {}
  for (const [kind, points] of byKind) series[kind] = [...points.values()].sort((a, b) => a.t - b.t)
  const sensors = [...used.values()].sort(
    (a, b) => a.node.localeCompare(b.node) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  )
  return { nodes: nodesOf(store, test), sensors, series }
}

export type StatRow = SensorRef & { min: number; avg: number; max: number; samples: number }

// Minimum, average and maximum of every sensor over the test.
export function testStats(store: Store, test: TestRow) {
  const refs = sensorRefs(store, test.nodeIds)
  const [from, to] = windowOf(test)
  const sensors: StatRow[] = store
    .sensorStats(test.nodeIds, from, to)
    .map((s: SensorStat) => ({
      ...refFor(refs, store, s.nodeId, s.sensor),
      min: s.min,
      avg: s.avg,
      max: s.max,
      samples: s.samples,
    }))
    .sort((a, b) => a.node.localeCompare(b.node) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  return { nodes: nodesOf(store, test), sensors }
}

// --- export ---

const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

type Table = { columns: string[]; rows: { time: number; elapsed: number; values: (number | null)[] }[]; stats: SensorStat[] }

// The readings of one node as a table with one row per second.
function nodeTable(store: Store, test: TestRow, nodeId: string): Table {
  const [from, to] = windowOf(test)
  const stats = store.sensorStats([nodeId], from, to)
  const columns = stats.map((s) => s.sensor)
  const index = new Map(columns.map((c, i) => [c, i]))
  const startSecond = Math.floor(test.startedAt / 1000)
  const seconds = new Map<number, (number | null)[]>()
  for (const row of store.rawSamples(nodeId, from, to)) {
    const second = Math.floor(row.ts / 1000)
    let values = seconds.get(second)
    if (!values) seconds.set(second, (values = columns.map(() => null)))
    values[index.get(row.sensor)!] = row.value
  }
  return {
    columns,
    stats,
    rows: [...seconds].sort((a, b) => a[0] - b[0]).map(([time, values]) => ({ time, elapsed: time - startSecond, values })),
  }
}

// The format of the powerlog tool: time,elapsed,<sensor ids...> once a second, and at the
// end a blank line and the rows "min" and "max".
export function testCsv(store: Store, test: TestRow, nodeId: string) {
  const { columns, rows, stats } = nodeTable(store, test, nodeId)
  const fmt = (v: number | null) => (v === null ? "" : v.toFixed(4))
  const lines = [`time,elapsed${columns.map((c) => `,${cell(c)}`).join("")}`]
  for (const row of rows) lines.push(`${row.time},${row.elapsed},${row.values.map(fmt).join(",")}`)
  lines.push("")
  lines.push(`min,,${stats.map((s) => fmt(s.min)).join(",")}`)
  lines.push(`max,,${stats.map((s) => fmt(s.max)).join(",")}`)
  return lines.join("\n") + "\n"
}

export function testExportJson(store: Store, test: TestRow, testInfo: unknown, nodeIds = test.nodeIds) {
  const refs = sensorRefs(store, test.nodeIds)
  return {
    test: testInfo,
    nodes: nodeIds.map((nodeId) => {
      const { columns, rows, stats } = nodeTable(store, test, nodeId)
      return {
        id: nodeId,
        name: store.getNode(nodeId)?.name ?? nodeId,
        sensors: columns.map((id, i) => {
          const ref = refFor(refs, store, nodeId, id)
          const s = stats[i]
          return { id, label: ref.label, kind: ref.kind, unit: ref.unit, min: s.min, avg: s.avg, max: s.max }
        }),
        columns: ["time", "elapsed", ...columns],
        rows: rows.map((r) => [r.time, r.elapsed, ...r.values]),
      }
    }),
  }
}
