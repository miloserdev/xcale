"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { ApiError, ApiUnauthorizedError, apiMutate } from "@/lib/api"

export type ScriptResult = {
  ok?: boolean
  error?: string
  path?: string
  sha256?: string
}

const enc = encodeURIComponent
const file = (cluster: string, path: string, query = "") =>
  `/api/clusters/${enc(cluster)}/scripts/file?path=${enc(path)}${query}`

async function guarded(
  fn: () => Promise<Partial<ScriptResult> | void>
): Promise<ScriptResult> {
  try {
    const result = await fn()
    // the lists on the pages read the files and the sync state of the nodes
    revalidatePath("/", "layout")
    return { ok: true, ...(result ?? {}) }
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiError) return { error: error.message }
    return { error: "The xcale server is not responding." }
  }
}

// `base` is the sha256 the editor started from: a file changed by someone else meanwhile
// is not overwritten.
export async function saveScriptAction(
  cluster: string,
  path: string,
  base: string,
  content: string
) {
  return guarded(async () => {
    const saved = await apiMutate<{ sha256: string }>(
      "PUT",
      file(cluster, path, `&base=${enc(base)}`),
      new TextEncoder().encode(content)
    )
    return { path, sha256: saved.sha256 }
  })
}

export async function createScriptAction(
  cluster: string,
  path: string,
  content: string
) {
  return guarded(async () => {
    await apiMutate(
      "PUT",
      file(cluster, path, "&base=new"),
      new TextEncoder().encode(content)
    )
    return { path }
  })
}

// Uploads files (binary too) into a folder; an existing file with the same name is replaced.
export async function uploadScriptsAction(
  cluster: string,
  folder: string,
  formData: FormData
) {
  return guarded(async () => {
    let last = ""
    for (const entry of formData.getAll("files")) {
      if (!(entry instanceof File)) continue
      const path = `${folder ? `${folder}/` : ""}${entry.name}`
      await apiMutate(
        "PUT",
        file(cluster, path, "&base=any"),
        new Uint8Array(await entry.arrayBuffer())
      )
      last = path
    }
    return { path: last }
  })
}

// Replaces one file (binary too) with the uploaded one, keeping its path.
export async function replaceScriptAction(
  cluster: string,
  path: string,
  formData: FormData
) {
  return guarded(async () => {
    const entry = formData.get("file")
    if (!(entry instanceof File)) throw new ApiError("choose a file")
    await apiMutate(
      "PUT",
      file(cluster, path, "&base=any"),
      new Uint8Array(await entry.arrayBuffer())
    )
    return { path }
  })
}

export async function renameScriptAction(
  cluster: string,
  from: string,
  to: string
) {
  return guarded(async () => {
    await apiMutate("POST", `/api/clusters/${enc(cluster)}/scripts/rename`, {
      from,
      to,
    })
    return { path: to }
  })
}

export async function deleteScriptAction(cluster: string, path: string) {
  return guarded(async () => {
    await apiMutate("DELETE", file(cluster, path))
  })
}

export async function syncClusterAction(cluster: string) {
  return guarded(async () => {
    await apiMutate("POST", `/api/clusters/${enc(cluster)}/sync`)
  })
}
