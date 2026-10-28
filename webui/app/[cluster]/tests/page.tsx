import Link from "next/link"
import { PlusIcon } from "lucide-react"

import { AutoRefresh } from "@/components/auto-refresh"
import { Button } from "@/components/ui/button"
import { TestsFilters } from "@/components/tests-filters"
import { TestsTable } from "@/components/tests-table"
import { getTests } from "@/lib/api"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string }>
}) {
  const { cluster } = await params
  const tests = await getTests(cluster)

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <AutoRefresh
        enabled={tests.some(
          (t) => t.status === "running" || t.status === "queued"
        )}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Tests</h1>
        <Button
          nativeButton={false}
          render={<Link href={`/${cluster}/tests/new`} />}
        >
          <PlusIcon />
          New test
        </Button>
      </div>
      <TestsFilters />
      <TestsTable tests={tests} />
    </div>
  )
}
