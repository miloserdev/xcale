import { AutoRefresh } from "@/components/auto-refresh"
import { ClusterOverview } from "@/components/cluster-overview"
import { getOverview } from "@/lib/api"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string }>
}) {
  const { cluster } = await params
  const overview = await getOverview(cluster)

  return (
    <>
      {/* fast while tests run, slow otherwise (nodes connecting or dropping) */}
      <AutoRefresh
        enabled
        intervalMs={overview.active.total > 0 ? 3000 : 10_000}
      />
      <ClusterOverview overview={overview} />
    </>
  )
}
