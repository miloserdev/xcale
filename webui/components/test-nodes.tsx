"use client"

import * as React from "react"
import { createColumnHelper } from "@tanstack/react-table"
import { DownloadIcon, LoaderIcon } from "lucide-react"

import { DataTable, features } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { formatDuration } from "@/lib/format"
import type { NodeRun, NodeStatus } from "@/lib/types"

const badge: Record<
  NodeStatus,
  { variant: React.ComponentProps<typeof Badge>["variant"]; className?: string }
> = {
  waiting: { variant: "outline" },
  running: { variant: "default" },
  passed: {
    variant: "secondary",
    className: "bg-green-600/15 text-green-700 dark:text-green-400",
  },
  failed: { variant: "destructive" },
  stopped: { variant: "ghost", className: "text-muted-foreground" },
  lost: { variant: "destructive" },
}

const helper = createColumnHelper<typeof features, NodeRun>()

// The nodes of a test. What is selected here decides whose data the charts, the console,
// the sensor table and the export below show; nothing selected means all nodes.
export function TestNodes({
  cluster,
  testId,
  nodes,
  finished,
  selected,
  onSelectedChange,
}: {
  cluster: string
  testId: string
  nodes: NodeRun[]
  finished: boolean
  selected: string[]
  onSelectedChange: (ids: string[]) => void
}) {
  const [format, setFormat] = React.useState<"csv" | "json">("csv")
  const [query, setQuery] = React.useState("")
  // a new key clears the selection kept inside the table
  const [reset, setReset] = React.useState(0)

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? nodes.filter((n) => n.name.toLowerCase().includes(needle))
    : nodes
  const chosen = nodes.filter((n) => selected.includes(n.nodeId))

  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Node",
          cell: ({ row }) => (
            <span className="font-medium">{row.original.name}</span>
          ),
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => {
            const node = row.original
            const { variant, className } = badge[node.status]
            return (
              <Badge variant={variant} className={className}>
                {node.status === "running" && (
                  <LoaderIcon className="animate-spin" />
                )}
                {node.status === "waiting" && finished
                  ? "not started"
                  : node.status}
              </Badge>
            )
          },
        }),
        helper.accessor(
          (node) =>
            node.startedAt !== null && node.finishedAt !== null
              ? node.finishedAt - node.startedAt
              : -1,
          {
            id: "time",
            header: "Time",
            cell: ({ row }) =>
              row.original.startedAt !== null &&
              row.original.finishedAt !== null
                ? formatDuration(
                    row.original.finishedAt - row.original.startedAt
                  )
                : "—",
          }
        ),
        helper.accessor((node) => node.error ?? "", {
          id: "result",
          header: "Result",
          cell: ({ row }) => (
            <span className="block max-w-64 truncate text-xs text-muted-foreground">
              {row.original.error ?? ""}
            </span>
          ),
        }),
      ]),
    [finished]
  )

  // all nodes: no list in the address, the server takes every node
  const params = new URLSearchParams({ format })
  if (chosen.length && chosen.length < nodes.length)
    params.set("nodes", chosen.map((n) => n.name).join(","))
  const href = `/api/export/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(testId)}?${params}`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="uppercase">
          {chosen.length
            ? `${chosen.length} of ${nodes.length} nodes`
            : "All nodes"}
        </CardTitle>
        <CardDescription>
          {chosen.length
            ? chosen.length <= 5
              ? chosen.map((n) => n.name).join(", ")
              : `${chosen
                  .slice(0, 5)
                  .map((n) => n.name)
                  .join(", ")} and ${chosen.length - 5} more`
            : "Select nodes to show only their data below; nothing selected shows all nodes."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            placeholder="Find a node"
            className="h-8 w-48"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {chosen.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onSelectedChange([])
                setReset((n) => n + 1)
              }}
            >
              Show all nodes
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex">
              {(["csv", "json"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={format === value ? "default" : "outline"}
                  className="first:rounded-r-none last:rounded-l-none"
                  onClick={() => setFormat(value)}
                  title={
                    value === "csv"
                      ? "A zip archive with a CSV file per node"
                      : "One JSON file for all nodes"
                  }
                >
                  {value === "csv" ? "CSV (zip)" : "JSON"}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              nativeButton={false}
              render={<a href={href} download />}
            >
              <DownloadIcon />
              Export {chosen.length ? chosen.length : "all"}
            </Button>
          </div>
        </div>
        <DataTable
          key={reset}
          columns={columns}
          data={visible}
          getRowId={(node) => node.nodeId}
          initialSelected={selected}
          onSelectionChange={onSelectedChange}
        />
      </CardContent>
    </Card>
  )
}
