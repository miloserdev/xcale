"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { createColumnHelper } from "@tanstack/react-table"
import { RotateCcwIcon, SquareIcon, Trash2Icon } from "lucide-react"

import {
  deleteTestsAction,
  rerunTestsAction,
  stopTestsAction,
} from "@/app/[cluster]/tests/actions"
import { BulkButton } from "@/components/bulk-confirm"
import { DataTable, features } from "@/components/data-table"
import { useCluster } from "@/components/cluster-provider"
import { TestStatusBadge } from "@/components/test-status-badge"
import { formatDuration, formatResult, nodeNames } from "@/lib/format"
import type { Test } from "@/lib/types"
import { filterTests, parseTestFilters } from "@/lib/test-filters"

const helper = createColumnHelper<typeof features, Test>()

const startedFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "UTC",
})

export function TestsTable({
  tests,
  pageSize,
}: {
  tests: Test[]
  pageSize?: number
}) {
  const { activeCluster } = useCluster()
  const searchParams = useSearchParams()
  const data = React.useMemo(
    () => filterTests(tests, parseTestFilters(searchParams)),
    [tests, searchParams]
  )
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Test",
          cell: ({ row }) => (
            <Link
              href={`/${activeCluster.id}/tests/${row.original.id}`}
              className="flex flex-col"
            >
              <span className="font-medium hover:underline">
                {row.original.name}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {row.original.id}
              </span>
            </Link>
          ),
        }),
        helper.accessor("status", {
          header: "Status",
          cell: ({ row }) => <TestStatusBadge status={row.original.status} />,
        }),
        helper.accessor(
          (test) => nodeNames(activeCluster.nodes, test.nodeIds),
          {
            id: "nodes",
            header: "Nodes",
            cell: ({ row }) =>
              nodeNames(activeCluster.nodes, row.original.nodeIds),
          }
        ),
        helper.accessor("startedAt", {
          header: "Started",
          cell: ({ row }) => (
            <div className="flex flex-col">
              <span>
                {startedFormat.format(new Date(row.original.startedAt))}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDuration(row.original.durationMs) ?? "—"}
              </span>
            </div>
          ),
        }),
        helper.accessor((test) => test.result?.maxTemp, {
          id: "result",
          header: "Result",
          sortUndefined: "last",
          cell: ({ row }) => (
            <span className="tabular-nums">
              {formatResult(row.original.result)}
            </span>
          ),
        }),
        helper.accessor("startedBy", { header: "By" }),
      ]),
    [activeCluster]
  )

  const isActive = (t: Test) => t.status === "running" || t.status === "queued"

  return (
    <DataTable
      columns={columns}
      data={data}
      pageSize={pageSize}
      getRowId={(test) => test.id}
      bulkActions={(selected, clear) => {
        const cluster = activeCluster.id
        const names = Object.fromEntries(selected.map((t) => [t.id, t.name]))
        const active = selected.filter(isActive)
        const finished = selected.filter((t) => !isActive(t))
        return (
          <>
            <BulkButton
              label="Rerun"
              icon={<RotateCcwIcon />}
              confirm={{
                title: `Rerun ${selected.length} test(s)?`,
                description:
                  "A new test with the same scripts, nodes and parameters is started for each selected one; they wait in the queue for busy nodes.",
                action: "Rerun",
              }}
              run={() =>
                rerunTestsAction(cluster, selected.map((t) => t.id), names)
              }
              onDone={clear}
            />
            <BulkButton
              label={`Stop (${active.length})`}
              icon={<SquareIcon />}
              disabled={!active.length}
              confirm={{
                title: `Stop ${active.length} test(s)?`,
                description:
                  "Running tests are terminated on every node and marked as aborted; waiting ones leave the queue. Finished tests in the selection are left alone.",
                action: "Stop tests",
              }}
              run={() =>
                stopTestsAction(cluster, active.map((t) => t.id), names)
              }
            />
            <BulkButton
              label={`Delete (${finished.length})`}
              icon={<Trash2Icon />}
              variant="destructive"
              disabled={!finished.length}
              confirm={{
                title: `Delete ${finished.length} test(s)?`,
                description:
                  "The tests and their logs are removed, sensor history stays. Running and waiting tests in the selection are skipped: stop them first.",
                action: "Delete tests",
              }}
              run={() =>
                deleteTestsAction(cluster, finished.map((t) => t.id), names)
              }
              onDone={clear}
            />
          </>
        )
      }}
    />
  )
}
