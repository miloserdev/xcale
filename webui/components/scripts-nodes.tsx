"use client"

import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { syncClusterAction } from "@/lib/script-actions"
import type { Node } from "@/lib/types"

// The version of the scripts directory of the cluster and how many nodes have it.
export function ScriptsNodes({
  cluster,
  version,
  nodes,
}: {
  cluster: string
  version: string
  nodes: Node[]
}) {
  const [pending, startTransition] = React.useTransition()
  const online = nodes.filter((s) => s.online).length
  const synced = nodes.filter((s) => s.syncStatus === "synced").length

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nodes</CardTitle>
        <CardDescription>
          Directory version <span className="font-mono">{version}</span> ·{" "}
          {synced} / {nodes.length} synced. It is copied to the nodes after
          every change and before every test.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || online === 0}
            onClick={() =>
              startTransition(() => void syncClusterAction(cluster))
            }
          >
            <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
            Sync now
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  )
}
