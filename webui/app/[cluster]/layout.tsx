import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { ClusterBreadcrumb } from "@/components/cluster-breadcrumb"
import { ClusterProvider } from "@/components/cluster-provider"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ServerUnavailable } from "@/components/server-unavailable"
import {
  ApiUnauthorizedError,
  ApiUnavailableError,
  getMe,
  getNodes,
  getClusters,
} from "@/lib/api"

export default async function ClusterLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ cluster: string }>
}) {
  const { cluster } = await params
  let clusters, nodes, me
  try {
    me = await getMe()
    clusters = await getClusters()
    // a stale address (the cluster was deleted or renamed, another database): start over
    // from the first cluster instead of a dead end
    if (!clusters.some((s) => s.id === cluster)) redirect("/")
    nodes = await getNodes(cluster)
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiUnavailableError) return <ServerUnavailable />
    throw error
  }
  const current = clusters.find((s) => s.id === cluster)!

  return (
    <ClusterProvider
      clusters={clusters}
      activeCluster={{ id: current.id, name: current.name, nodes }}
    >
      <SidebarProvider>
        <AppSidebar user={{ name: me.username }} />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <ClusterBreadcrumb />
            </div>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </ClusterProvider>
  )
}
