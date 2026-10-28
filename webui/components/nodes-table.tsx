"use client"

import * as React from "react"
import Link from "next/link"
import { createColumnHelper } from "@tanstack/react-table"
import { FlaskConicalIcon, Trash2Icon } from "lucide-react"

import { BulkButton } from "@/components/bulk-confirm"
import { DataTable, features } from "@/components/data-table"
import { useCluster } from "@/components/cluster-provider"
import { NodeGroupDialog } from "@/components/node-group-dialog"
import { SyncBadge } from "@/components/sync-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { deleteNodesAction } from "@/lib/cluster-actions"
import { formatUptime } from "@/lib/format"
import type { Node } from "@/lib/types"

const helper = createColumnHelper<typeof features, Node>()

// The nodes of a cluster with a filter by group. With `picker` the table is a part of a
// form: the selected nodes are submitted as `nodeIds`, starting with `picker.initial`.
export function NodesTable({
  nodes,
  picker,
}: {
  nodes: Node[]
  picker?: { initial?: string[] }
}) {
  const { activeCluster } = useCluster()
  const [group, setGroup] = React.useState<string | null>(null) // null: all
  const [selectedIds, setSelectedIds] = React.useState(picker?.initial ?? [])
  const groups = React.useMemo(
    () =>
      [...new Set(nodes.flatMap((s) => (s.group ? [s.group] : [])))].sort(),
    [nodes]
  )
  const selectedCount = selectedIds.filter((id) =>
    nodes.some((s) => s.id === id)
  ).length
  const hasUngrouped = nodes.some((s) => !s.group)
  // a group that disappeared (its nodes were regrouped) is not a filter any more
  const filter =
    group === "" ? group : group && groups.includes(group) ? group : null
  const shown = React.useMemo(
    () =>
      filter === null
        ? nodes
        : nodes.filter((s) => (s.group ?? "") === filter),
    [nodes, filter]
  )
  const isPicker = !!picker
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          cell: ({ row }) => (
            <Link
              href={`/${activeCluster.id}/nodes/${row.original.id}`}
              className="font-medium hover:underline"
            >
              {row.original.name}
            </Link>
          ),
        }),
        helper.accessor((node) => node.group ?? "", {
          id: "group",
          header: "Group",
          cell: ({ row }) =>
            row.original.group ? (
              <Badge variant="secondary">{row.original.group}</Badge>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }),
        helper.accessor((node) => node.lastIp ?? "", {
          id: "ip",
          header: "IP",
          cell: ({ row }) => (
            <span className="font-mono text-xs">
              {row.original.lastIp ?? "—"}
            </span>
          ),
        }),
        helper.accessor("online", {
          header: "Status",
          cell: ({ row }) => (
            <Badge variant={row.original.online ? "default" : "destructive"}>
              {row.original.online ? "online" : "offline"}
            </Badge>
          ),
        }),
        // the form of a test shows no sync state: the scripts are copied before it starts
        ...(isPicker
          ? []
          : [
              helper.accessor("syncStatus", {
                header: "Scripts",
                cell: ({ row }) => <SyncBadge node={row.original} />,
              }),
            ]),
        helper.accessor((node) => node.info.boot_ts ?? 0, {
          id: "uptime",
          header: "Uptime",
          // sort by boot time; a longer uptime is an earlier boot
          cell: ({ row }) => formatUptime(row.original.info.boot_ts),
        }),
      ]),
    [activeCluster, isPicker]
  )

  const groupFilter = groups.length > 0 && (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Group</span>
      <Button
        variant={filter === null ? "default" : "outline"}
        size="xs"
        onClick={() => setGroup(null)}
      >
        All ({nodes.length})
      </Button>
      {groups.map((name) => (
        <Button
          key={name}
          variant={filter === name ? "default" : "outline"}
          size="xs"
          onClick={() => setGroup(name)}
        >
          {name} ({nodes.filter((s) => s.group === name).length})
        </Button>
      ))}
      {hasUngrouped && (
        <Button
          variant={filter === "" ? "default" : "outline"}
          size="xs"
          onClick={() => setGroup("")}
        >
          No group ({nodes.filter((s) => !s.group).length})
        </Button>
      )}
    </div>
  )

  if (picker)
    return (
      <div className="flex flex-col gap-2">
        {selectedIds
          .filter((id) => nodes.some((s) => s.id === id))
          .map((id) => (
            <input key={id} type="hidden" name="nodeIds" value={id} />
          ))}
        <DataTable
          columns={columns}
          data={shown}
          getRowId={(node) => node.id}
          initialSelected={picker.initial}
          onSelectionChange={setSelectedIds}
          toolbar={groupFilter}
        />
        <p className="text-sm text-muted-foreground">
          {selectedCount} node(s) selected. Filter by group and use the
          checkbox in the header to select the whole group.
        </p>
      </div>
    )

  return (
    <DataTable
      columns={columns}
      data={shown}
      getRowId={(node) => node.id}
      toolbar={groupFilter}
      bulkActions={(selected, clear) => (
        <>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={
              <Link
                href={`/${activeCluster.id}/tests/new?nodes=${selected
                  .map((s) => encodeURIComponent(s.id))
                  .join(",")}`}
              />
            }
          >
            <FlaskConicalIcon />
            Run test
          </Button>
          <NodeGroupDialog
            cluster={activeCluster.id}
            ids={selected.map((s) => s.id)}
            groups={groups}
            onDone={clear}
          />
          <BulkButton
            label="Delete"
            icon={<Trash2Icon />}
            variant="destructive"
            confirm={{
              title: `Delete ${selected.length} node(s)?`,
              description:
                "The nodes and their sensor history are removed, the tests that ran on them stay in the history. Nodes with a running or waiting test are skipped and reported.",
              action: "Delete nodes",
            }}
            run={() =>
              deleteNodesAction(
                activeCluster.id,
                selected.map((s) => s.id),
                Object.fromEntries(selected.map((s) => [s.id, s.name]))
              )
            }
            onDone={clear}
          />
        </>
      )}
    />
  )
}
