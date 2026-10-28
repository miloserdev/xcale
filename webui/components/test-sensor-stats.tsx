"use client"

import * as React from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { sensorNames } from "@/lib/sensor-names"
import type { TestStats } from "@/lib/types"

const num = (value: number) => +value.toFixed(2)

// min / avg / max of every sensor over the test; while the test runs the numbers are
// refreshed every few seconds
export function TestSensorStats({
  cluster,
  testId,
  initial,
  active,
  nodeIds,
}: {
  cluster: string
  testId: string
  initial: TestStats
  active: boolean
  nodeIds: string[] // none: all nodes
}) {
  const [all, setStats] = React.useState(initial)
  const stats = React.useMemo(
    () =>
      nodeIds.length
        ? {
            nodes: all.nodes.filter((n) => nodeIds.includes(n.id)),
            sensors: all.sensors.filter((s) => nodeIds.includes(s.nodeId)),
          }
        : all,
    [all, nodeIds]
  )
  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/stats/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(testId)}`,
          { cache: "no-store" }
        )
        if (res.ok) setStats((await res.json()) as TestStats)
      } catch {
        // the next tick tries again
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [active, cluster, testId])

  if (!stats.sensors.length) return null
  const multiNode = stats.nodes.length > 1
  const names = sensorNames(stats.sensors)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sensors</CardTitle>
        <CardDescription>
          Minimum, average and maximum over the test
        </CardDescription>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {multiNode && <TableHead>Node</TableHead>}
              <TableHead>Sensor</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Min</TableHead>
              <TableHead className="text-right">Avg</TableHead>
              <TableHead className="text-right">Max</TableHead>
              <TableHead>Unit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.sensors.map((s) => (
              <TableRow key={s.key}>
                {multiNode && <TableCell>{s.node}</TableCell>}
                <TableCell title={s.id}>
                  <span className="font-mono text-xs">
                    {names.get(s.key) ?? s.label}
                  </span>
                </TableCell>
                <TableCell>{s.kind}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(s.min)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(s.avg)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(s.max)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {s.unit}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
