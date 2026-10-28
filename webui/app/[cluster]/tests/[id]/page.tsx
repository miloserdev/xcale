import { TestActions } from "@/components/test-actions"
import { TestLive } from "@/components/test-live"
import { TestStatusBadge } from "@/components/test-status-badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  getTest,
  getTestLog,
  getTestNodes,
  getTestStats,
  getTestTelemetry,
} from "@/lib/api"
import { formatDuration } from "@/lib/format"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string; id: string }>
}) {
  const { cluster, id } = await params
  const [test, telemetry, log, stats, nodes] = await Promise.all([
    getTest(cluster, id),
    getTestTelemetry(cluster, id),
    getTestLog(cluster, id),
    getTestStats(cluster, id),
    getTestNodes(cluster, id),
  ])

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">{test.name}</h1>
          <TestStatusBadge status={test.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TestActions cluster={cluster} test={test} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{test.id}</span> · started{" "}
          {test.startedAt.slice(0, 16).replace("T", " ")} UTC by{" "}
          {test.startedBy}
        </p>
      </div>
      <div className="flex gap-6 text-sm">
        <span className="text-muted-foreground">
          Duration{" "}
          <span className="text-base font-medium text-foreground tabular-nums">
            {formatDuration(test.durationMs) ?? "—"}
          </span>
        </span>
      </div>
      <TestLive
        key={test.status}
        cluster={cluster}
        testId={test.id}
        status={test.status}
        initialLines={log}
        initialTelemetry={telemetry}
        initialNodes={nodes}
        initialStats={stats}
        emptyMessage={
          test.status === "queued"
            ? "No sensor data yet: the test has not started."
            : "No sensor data recorded: no agent reported from these nodes during the test."
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            {test.nodeIds.length}{" "}
            {test.nodeIds.length === 1 ? "node" : "nodes"}, listed in the
            nodes table above.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {Object.entries(test.configs).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="font-mono text-xs text-muted-foreground">
            {test.scriptsPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
