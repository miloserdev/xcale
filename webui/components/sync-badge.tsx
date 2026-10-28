import { CheckIcon, XIcon, LoaderIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { Node } from "@/lib/types"

// The state of the scripts directory on a node compared with the cluster.
export function SyncBadge({
  node,
}: {
  node: Pick<Node, "syncStatus" | "syncVersion" | "syncError">
}) {
  switch (node.syncStatus) {
    case "synced":
      return (
        <Badge
          variant="secondary"
          title={`version ${node.syncVersion ?? ""}`}
        >
          <CheckIcon />
          synced
        </Badge>
      )
    case "syncing":
      return (
        <Badge variant="outline">
          <LoaderIcon className="animate-spin" />
          syncing
        </Badge>
      )
    case "outdated":
      return <Badge variant="outline">outdated</Badge>
    case "failed":
      return (
        <Badge variant="destructive" title={node.syncError ?? undefined}>
          sync failed
        </Badge>
      )
    default:
      return (
      <Badge variant="outline">
          <XIcon />
          not synced yet
        </Badge>
      )
  }
}
