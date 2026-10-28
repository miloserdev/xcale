"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { AutoRefresh } from "@/components/auto-refresh"
import { TestCharts } from "@/components/test-charts"
import { TestConsole } from "@/components/test-console"
import { TestNodes } from "@/components/test-nodes"
import { TestRunTrace } from "@/components/test-run-trace"
import { TestSensorStats } from "@/components/test-sensor-stats"
import type {
  LogLine,
  NodeRun,
  Telemetry,
  TestSensor,
  TestStats,
  TestStatus,
} from "@/lib/types"

const minute = 60_000

type PointEvent = {
  t: number
  values: Record<string, number>
  meta?: Record<string, TestSensor>
}

// Folds the latest sensor values of a `point` event into the per-minute series; sensors
// that were not known yet arrive with their description in `meta`.
function applyPoint(telemetry: Telemetry, point: PointEvent): Telemetry {
  const bucket = Math.floor(point.t / minute) * minute
  const sensors = [...telemetry.sensors]
  for (const sensor of Object.values(point.meta ?? {})) {
    if (!sensors.some((s) => s.key === sensor.key)) sensors.push(sensor)
  }
  const nodes = [...telemetry.nodes]
  for (const sensor of sensors) {
    if (!nodes.some((n) => n.id === sensor.nodeId))
      nodes.push({ id: sensor.nodeId, name: sensor.node })
  }
  const kindOf = new Map(sensors.map((s) => [s.key, s.kind]))
  const series = { ...telemetry.series }
  const byKind = new Map<string, Record<string, number>>()
  for (const [key, value] of Object.entries(point.values)) {
    const kind = kindOf.get(key) ?? "other"
    byKind.set(kind, { ...byKind.get(kind), [key]: value })
  }
  for (const [kind, values] of byKind) {
    const list = [...(series[kind] ?? [])]
    const at = list.findIndex((p) => p.t === bucket)
    if (at >= 0) {
      list[at] = { ...list[at], ...values }
    } else {
      list.push({
        t: bucket,
        time: new Date(bucket).toISOString().slice(11, 16),
        ...values,
      })
    }
    series[kind] = list.slice(-500)
  }
  return { nodes, sensors, series }
}

// The live part of a test page: progress, machines, charts and console. While the test runs
// they follow the server-sent event stream; a change of the test status reloads the page
// data (header, results). If the stream cannot be opened the page falls back to polling.
export function TestLive({
  cluster,
  testId,
  status,
  initialLines,
  initialTelemetry,
  initialNodes,
  initialStats,
  emptyMessage,
}: {
  cluster: string
  testId: string
  status: TestStatus
  initialLines: LogLine[]
  initialTelemetry: Telemetry
  initialNodes: NodeRun[]
  initialStats: TestStats
  emptyMessage: string
}) {
  const router = useRouter()
  const active = status === "running" || status === "queued"
  const [extra, setExtra] = React.useState<LogLine[]>([])
  const [telemetry, setTelemetry] = React.useState(initialTelemetry)
  const [nodes, setNodes] = React.useState(initialNodes)
  // the nodes whose data the page shows; none selected: all of them
  const [selected, setSelected] = React.useState<string[]>([])
  const [fallback, setFallback] = React.useState(false)
  const lastId = React.useRef(initialLines.at(-1)?.id ?? 0)

  React.useEffect(() => {
    if (!active) return
    const source = new EventSource(
      `/api/stream/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(testId)}?after=${lastId.current}`
    )
    source.addEventListener("log", (event) => {
      const line = JSON.parse(event.data) as LogLine
      lastId.current = line.id
      setExtra((lines) => [...lines, line])
    })
    source.addEventListener("point", (event) => {
      setTelemetry((current) => applyPoint(current, JSON.parse(event.data)))
    })
    source.addEventListener("node", (event) => {
      const run = JSON.parse(event.data) as NodeRun
      setNodes((current) =>
        current.some((n) => n.nodeId === run.nodeId)
          ? current.map((n) => (n.nodeId === run.nodeId ? run : n))
          : [...current, run]
      )
    })
    source.addEventListener("status", (event) => {
      const next = JSON.parse(event.data) as { status: TestStatus }
      if (next.status !== status) {
        source.close()
        router.refresh()
      }
    })
    // CLOSED means the server refused the stream (the browser does not retry then)
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setFallback(true)
    }
    return () => source.close()
  }, [active, cluster, testId, status, router])

  const lines = React.useMemo(() => {
    const all = [...initialLines, ...extra]
    if (!selected.length) return all.map((l) => l.line)
    // lines of tests that ran before log lines knew their machine start with its name
    const legacy = nodes
      .filter((n) => selected.includes(n.nodeId))
      .map((n) => n.name.replace(/[^\w-]/g, "\\$&"))
    const legacyLine = legacy.length
      ? new RegExp(`^\\[[\\d:]+\\] (${legacy.join("|")})[: ]`)
      : null
    return all
      .filter(
        (l) =>
          (l.nodeId !== null && selected.includes(l.nodeId)) ||
          (l.nodeId === null && legacyLine?.test(l.line))
      )
      .map((l) => l.line)
  }, [initialLines, extra, selected, nodes])

  const shownTelemetry = React.useMemo(() => {
    if (!selected.length) return telemetry
    const sensors = telemetry.sensors.filter((s) =>
      selected.includes(s.nodeId)
    )
    const kinds = new Set(sensors.map((s) => s.kind))
    return {
      nodes: telemetry.nodes.filter((n) => selected.includes(n.id)),
      sensors,
      series: Object.fromEntries(
        Object.entries(telemetry.series).filter(([kind]) => kinds.has(kind))
      ),
    }
  }, [telemetry, selected])

  return (
    <>
      <AutoRefresh enabled={active && fallback} />
      <TestRunTrace status={status} nodes={nodes} />
      <TestNodes
        cluster={cluster}
        testId={testId}
        nodes={nodes}
        finished={!active}
        selected={selected}
        onSelectedChange={setSelected}
      />
      <TestCharts telemetry={shownTelemetry} emptyMessage={emptyMessage} />
      <TestConsole
        lines={lines}
        title={
          selected.length
            ? `Console · ${selected.length} of ${nodes.length} nodes`
            : "Console · all nodes"
        }
      />
      <TestSensorStats
        cluster={cluster}
        testId={testId}
        initial={initialStats}
        active={active}
        nodeIds={selected}
      />
    </>
  )
}
