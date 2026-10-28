"use client"

import Link from "next/link"
import { BanIcon, CheckIcon, ClockIcon, LoaderIcon, XIcon } from "lucide-react"

import { useCluster } from "@/components/cluster-provider"
import { TestsTable } from "@/components/tests-table"
import {
  Card,
  CardAction,
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
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { formatDuration, nodeNames } from "@/lib/format"
import type { Overview, Test, TestStatus } from "@/lib/types"

const statusIcon: Record<TestStatus, React.ReactNode> = {
  running: <LoaderIcon className="animate-spin" />,
  queued: <ClockIcon />,
  passed: <CheckIcon />,
  failed: <XIcon />,
  aborted: <BanIcon />,
}

const linkClass =
  "text-sm text-muted-foreground hover:text-foreground hover:underline"

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

function TestTrace({
  test,
  nodes,
  clusterId,
}: {
  test: Test
  nodes: string
  clusterId: string
}) {
  const status =
    test.status === "queued"
      ? "pending"
      : test.status === "running"
        ? "running"
        : undefined
  return (
    <Link href={`/${clusterId}/tests/${test.id}`} className="w-fit max-w-full">
      <TraceLine status={status}>
        <TraceIcon>{statusIcon[test.status]}</TraceIcon>
        <TraceTitle>
          {test.name} · {nodes}
        </TraceTitle>
        {test.durationMs != null && (
          <TraceDescription>{formatDuration(test.durationMs)}</TraceDescription>
        )}
      </TraceLine>
    </Link>
  )
}

// A short summary, not a full list: only the most recent items with links to the full pages.
export function ClusterOverview({ overview }: { overview: Overview }) {
  const { activeCluster } = useCluster()
  const base = `/${activeCluster.id}`
  const { nodes, active, history } = overview
  const synced = activeCluster.nodes.filter(
    (s) => s.syncStatus === "synced"
  ).length

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Nodes</CardTitle>
            <CardAction>
              <Link href={`${base}/nodes`} className={linkClass}>
                All nodes
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {nodes.total ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Count</TableHead>
                    <TableHead>Online</TableHead>
                    <TableHead>Synced</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="tabular-nums">
                      {nodes.total}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {nodes.online} / {nodes.total}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {synced} / {nodes.total}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            ) : (
              <Empty>Add the first node on the Nodes page.</Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current tests</CardTitle>
            <CardDescription>
              {active.total === 0
                ? "Nothing is running"
                : `${active.total} running or waiting`}
            </CardDescription>
            <CardAction>
              <Link
                href={`${base}/tests?status=running,queued`}
                className={linkClass}
              >
                Show in list
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            {active.items.length ? (
              <Trace>
                {active.items.map((test) => (
                  <TestTrace
                    key={test.id}
                    test={test}
                    nodes={nodeNames(activeCluster.nodes, test.nodeIds)}
                    clusterId={activeCluster.id}
                  />
                ))}
              </Trace>
            ) : (
              <Empty>
                Tests that run or wait for a free node show up here.
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            {history.total === 0
              ? "No finished tests yet"
              : `Latest ${history.items.length} of ${history.total} finished tests`}
          </CardDescription>
          <CardAction>
            <Link href={`${base}/tests`} className={linkClass}>
              All tests
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent>
          {history.items.length ? (
            <TestsTable tests={history.items} pageSize={50} />
          ) : (
            <Empty>Finished tests show up here.</Empty>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
