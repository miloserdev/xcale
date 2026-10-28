"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { ApiError, ApiUnauthorizedError, apiMutate } from "@/lib/api"

export type FormState = { error?: string; ok?: boolean; id?: string } | null

const enc = encodeURIComponent

async function guarded(
  fn: () => Promise<string | void | { id: string }>
): Promise<FormState> {
  let target: string | void | { id: string }
  try {
    target = await fn()
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiError) return { error: error.message }
    return { error: "The xcale server is not responding." }
  }
  // the cluster switcher and the lists read their data in the layout
  revalidatePath("/", "layout")
  if (typeof target === "string") redirect(target) // outside try: redirect() throws
  return { ok: true, ...(target ?? {}) }
}

export async function createClusterAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const name = String(formData.get("name") ?? "").trim()
  return guarded(async () => {
    await apiMutate("POST", "/api/clusters", { name })
    return `/${name}`
  })
}

export async function deleteNodeAction(cluster: string, id: string) {
  return guarded(async () => {
    await apiMutate(
      "DELETE",
      `/api/clusters/${enc(cluster)}/nodes/${enc(id)}`
    )
  })
}

// Removes several nodes; the ones that cannot be removed (a test is running) are reported.
export async function deleteNodesAction(
  cluster: string,
  ids: string[],
  names: Record<string, string> = {}
): Promise<FormState> {
  const failed: string[] = []
  for (const id of ids) {
    try {
      await apiMutate("DELETE", `/api/clusters/${enc(cluster)}/nodes/${enc(id)}`)
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) redirect("/login")
      failed.push(
        `${names[id] ?? id}: ${error instanceof ApiError ? error.message : "failed"}`
      )
    }
  }
  revalidatePath("/", "layout")
  return failed.length ? { error: failed.join("; ") } : { ok: true }
}

// Puts the nodes into a group; an empty name takes them out of their group.
export async function setNodesGroupAction(
  cluster: string,
  ids: string[],
  group: string
): Promise<FormState> {
  return guarded(async () => {
    await apiMutate("PUT", `/api/clusters/${enc(cluster)}/nodes/group`, {
      ids,
      group: group.trim() || null,
    })
  })
}

// `stop`: the user confirmed that running tests are stopped first.
export async function deleteClusterAction(cluster: string, stop: boolean) {
  return guarded(async () => {
    await apiMutate(
      "DELETE",
      `/api/clusters/${enc(cluster)}${stop ? "?stop=true" : ""}`
    )
    return "/"
  })
}
