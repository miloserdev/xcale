import { AddNodeDialog } from "@/components/add-node-dialog"
import { AutoRefresh } from "@/components/auto-refresh"
import { NodesTable } from "@/components/nodes-table"
import { getNodes } from "@/lib/api"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string }>
}) {
  const { cluster } = await params
  const nodes = await getNodes(cluster)

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <AutoRefresh enabled intervalMs={10_000} />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Nodes</h1>
        <AddNodeDialog cluster={cluster} />
      </div>
      <NodesTable nodes={nodes} />
    </div>
  )
}
