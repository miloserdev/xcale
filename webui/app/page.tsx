import { redirect } from "next/navigation"

import { CreateClusterForm } from "@/components/create-cluster-form"
import { ServerUnavailable } from "@/components/server-unavailable"
import {
  ApiUnauthorizedError,
  ApiUnavailableError,
  getClusters,
} from "@/lib/api"

export default async function Page() {
  let first
  try {
    ;[first] = await getClusters()
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiUnavailableError) return <ServerUnavailable />
    throw error
  }
  if (first) redirect(`/${first.id}`)

  // no clusters yet (or all were deleted)
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold">Create your first cluster</h1>
          <p className="text-sm text-muted-foreground">
            A cluster is a group of nodes that tests run on.
          </p>
        </div>
        <CreateClusterForm />
      </div>
    </div>
  )
}
