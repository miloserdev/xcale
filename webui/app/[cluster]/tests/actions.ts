"use server"

import { redirect } from "next/navigation"

import { ApiError, ApiUnauthorizedError, apiMutate } from "@/lib/api"
import type { Test } from "@/lib/types"

export type ActionState = { error?: string } | null

const path = (cluster: string, id?: string, action?: string) =>
  `/api/clusters/${encodeURIComponent(cluster)}/tests` +
  (id ? `/${encodeURIComponent(id)}` : "") +
  (action ? `/${action}` : "")

async function guarded(fn: () => Promise<string | void>): Promise<ActionState> {
  let target: string | void
  try {
    target = await fn()
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiError) return { error: error.message }
    throw error
  }
  if (target) redirect(target) // outside try: redirect() throws
  return null
}

export async function createTestAction(
  cluster: string,
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const keys = formData.getAll("cfgKey").map(String)
  const values = formData.getAll("cfgValue").map(String)
  const configs: Record<string, string> = {}
  keys.forEach((key, i) => {
    if (key.trim()) configs[key.trim()] = (values[i] ?? "").trim()
  })

  return guarded(async () => {
    const test = await apiMutate<Test>("POST", path(cluster), {
      name: String(formData.get("name") ?? ""),
      scriptsPaths: formData.getAll("scriptsPaths").map(String),
      nodeIds: formData.getAll("nodeIds").map(String),
      configs,
    })
    return `/${cluster}/tests/${test.id}`
  })
}

export async function stopTestAction(cluster: string, id: string) {
  return guarded(async () => {
    await apiMutate("POST", path(cluster, id, "stop"))
  })
}

export async function rerunTestAction(cluster: string, id: string) {
  return guarded(async () => {
    const test = await apiMutate<Test>("POST", path(cluster, id, "rerun"))
    return `/${cluster}/tests/${test.id}`
  })
}

export async function deleteTestAction(cluster: string, id: string) {
  return guarded(async () => {
    await apiMutate("DELETE", path(cluster, id))
    return `/${cluster}/tests`
  })
}

// Bulk actions: every test is tried, the failures are reported together.
async function each(
  ids: string[],
  names: Record<string, string>,
  fn: (id: string) => Promise<unknown>
): Promise<ActionState> {
  const failed: string[] = []
  for (const id of ids) {
    try {
      await fn(id)
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) redirect("/login")
      failed.push(
        `${names[id] ?? id}: ${error instanceof ApiError ? error.message : "failed"}`
      )
    }
  }
  return failed.length ? { error: failed.join("; ") } : null
}

export async function stopTestsAction(
  cluster: string,
  ids: string[],
  names: Record<string, string> = {}
) {
  return each(ids, names, (id) => apiMutate("POST", path(cluster, id, "stop")))
}

export async function rerunTestsAction(
  cluster: string,
  ids: string[],
  names: Record<string, string> = {}
) {
  return each(ids, names, (id) => apiMutate("POST", path(cluster, id, "rerun")))
}

export async function deleteTestsAction(
  cluster: string,
  ids: string[],
  names: Record<string, string> = {}
) {
  return each(ids, names, (id) => apiMutate("DELETE", path(cluster, id)))
}
