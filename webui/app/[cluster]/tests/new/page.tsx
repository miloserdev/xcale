import { TestForm } from "@/components/test-form"
import { getScripts, getTest } from "@/lib/api"

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ cluster: string }>
  searchParams: Promise<{ from?: string; nodes?: string }>
}) {
  const { cluster } = await params
  const { from, nodes } = await searchParams
  const [list, initial] = await Promise.all([
    getScripts(cluster),
    from ? getTest(cluster, from) : undefined,
  ])

  // the scripts of the cluster directory that bash can run
  const scripts = list.files.map((f) => f.path).filter((p) => p.endsWith(".sh"))

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <h1 className="text-lg font-medium">
        {initial ? `Duplicate “${initial.name}”` : "New test"}
      </h1>
      <TestForm
        scripts={scripts}
        initial={initial}
        preselected={nodes?.split(",").filter(Boolean)}
      />
    </div>
  )
}
