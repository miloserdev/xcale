import { AutoRefresh } from "@/components/auto-refresh"
import { ScriptsNodes } from "@/components/scripts-nodes"
import { ScriptsWorkspace } from "@/components/scripts-workspace"
import { getScriptFile, getScripts, getNodes } from "@/lib/api"

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ cluster: string }>
  searchParams: Promise<{ file?: string; edit?: string }>
}) {
  const { cluster } = await params
  const { file: selected = null, edit } = await searchParams
  const [list, nodes, file] = await Promise.all([
    getScripts(cluster),
    getNodes(cluster),
    selected ? getScriptFile(cluster, selected) : Promise.resolve(null),
  ])
  const busy = nodes.some(
    (s) =>
      s.syncStatus === "syncing" || (s.online && s.syncStatus === "outdated")
  )

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      {/* sync progress shows up quickly, the rest changes rarely */}
      <AutoRefresh enabled intervalMs={busy ? 2000 : 10_000} />
      <h1 className="text-lg font-medium">Scripts</h1>
      <ScriptsNodes
        cluster={cluster}
        version={list.version}
        nodes={nodes}
      />
      <ScriptsWorkspace
        cluster={cluster}
        files={list.files}
        selected={selected}
        file={file}
        startEditing={edit === "1"}
      />
    </div>
  )
}
