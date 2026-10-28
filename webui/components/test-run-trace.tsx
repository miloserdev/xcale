import { CheckIcon, ClockIcon, LoaderIcon, UnplugIcon, XIcon } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { formatDuration } from "@/lib/format"
import type { NodeRun, TestStatus } from "@/lib/types"

const machines = (n: number) => `${n} ${n === 1 ? "machine" : "machines"}`

// The first card of a test: what runs where, and a line for every machine that is done.
export function TestRunTrace({
  status,
  nodes,
}: {
  status: TestStatus
  nodes: NodeRun[]
}) {
  const count = (state: string) => nodes.filter((n) => n.status === state).length
  const done = nodes
    .filter((n) => n.finishedAt !== null)
    .sort((a, b) => a.finishedAt! - b.finishedAt!)
  const running = count("running")
  const failed = count("failed") + count("lost")

  const headline =
    status === "queued"
      ? `Waiting for a free machine · ${machines(nodes.length)}`
      : status === "running"
        ? `Running on ${machines(nodes.length)}`
        : `Ran on ${machines(nodes.length)}`
  const summary = [
    running && `${running} running`,
    count("passed") && `${count("passed")} passed`,
    failed && `${failed} failed`,
    count("stopped") && `${count("stopped")} stopped`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Card>
      <CardHeader>
        <CardTitle>Progress</CardTitle>
        <CardDescription>{summary || "Nothing has started yet"}</CardDescription>
      </CardHeader>
      <CardContent>
        <Trace className="max-h-64 overflow-y-auto">
          <TraceLine
            status={
              status === "running"
                ? "running"
                : status === "queued"
                  ? "pending"
                  : undefined
            }
          >
            <TraceIcon>
              {status === "running" ? (
                <LoaderIcon className="animate-spin" />
              ) : status === "queued" ? (
                <ClockIcon />
              ) : (
                <CheckIcon />
              )}
            </TraceIcon>
            <TraceTitle>{headline}</TraceTitle>
          </TraceLine>
          {done.map((node) => {
            const bad = node.status === "failed" || node.status === "lost"
            const took =
              node.startedAt !== null && node.finishedAt !== null
                ? formatDuration(node.finishedAt - node.startedAt)
                : undefined
            return (
              <TraceLine
                key={node.nodeId}
                status={bad ? "error" : undefined}
                className={
                  node.status === "passed"
                    ? "text-green-600 dark:text-green-500"
                    : undefined
                }
              >
                <TraceIcon>
                  {node.status === "passed" ? (
                    <CheckIcon />
                  ) : node.status === "lost" ? (
                    <UnplugIcon />
                  ) : (
                    <XIcon />
                  )}
                </TraceIcon>
                <TraceTitle>
                  {node.status === "lost"
                    ? `machine ${node.name} disconnected`
                    : `machine ${node.name} ${node.status}`}
                  {node.error ? `, ${node.error}` : ""}
                </TraceTitle>
                {took && <TraceDescription>{took}</TraceDescription>}
              </TraceLine>
            )
          })}
        </Trace>
      </CardContent>
    </Card>
  )
}
