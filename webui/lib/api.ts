import { cache } from "react"
import { cookies } from "next/headers"
import { notFound } from "next/navigation"

import { sessionCookie } from "@/lib/session"

import type {
  LatestValue,
  LoadavgPoint,
  LogLine,
  Overview,
  Node,
  ClusterStats,
  ClusterSummary,
  ScriptContent,
  ScriptList,
  NodeRun,
  Telemetry,
  TestStats,
  Test,
} from "@/lib/types"

const base = process.env.XCALE_API ?? "http://127.0.0.1:4000"

// The xcale server cannot be reached or answered with a server error.
// Layouts catch it and render <ServerUnavailable /> instead of letting the render fail:
// a failed server render makes React render the whole tree again on the client.
export class ApiUnavailableError extends Error {}

// No session, or the session expired: sign in again.
export class ApiUnauthorizedError extends Error {}

// Every API call carries the session token that the browser keeps in an httpOnly cookie.
async function authHeaders(): Promise<Record<string, string>> {
  const token = (await cookies()).get(sessionCookie)?.value
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      cache: "no-store",
      headers: await authHeaders(),
    })
  } catch (error) {
    throw new ApiUnavailableError(`xcale server is unreachable (${base})`, {
      cause: error,
    })
  }
  if (res.status === 401) throw new ApiUnauthorizedError("not signed in")
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === "unknown route")
      throw new ApiUnavailableError(
        `the xcale server does not know ${path}: it is older than the web UI, restart it`
      )
    notFound()
  }
  if (!res.ok)
    throw new ApiUnavailableError(`xcale server: ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

// Not cached: the token is requested on demand (Server Actions), never during page render.
export function fetchAgentToken(cluster: string) {
  return request<{ token: string | null }>(`/api/clusters/${enc(cluster)}/token`)
}

export const getMe = cache(() => request<{ username: string }>("/api/auth/me"))

const enc = encodeURIComponent

// `cache` dedupes identical calls within one render (layout + page).
export const getClusters = cache(() =>
  request<ClusterSummary[]>("/api/clusters")
)

export const getCluster = cache((cluster: string) =>
  request<ClusterStats>(`/api/clusters/${enc(cluster)}`)
)

export const getNodes = cache((cluster: string) =>
  request<Node[]>(`/api/clusters/${enc(cluster)}/nodes`)
)

export const getNode = cache((cluster: string, id: string) =>
  request<Node>(`/api/clusters/${enc(cluster)}/nodes/${enc(id)}`)
)

export const getNodeLatest = cache((cluster: string, id: string) =>
  request<LatestValue[]>(
    `/api/clusters/${enc(cluster)}/nodes/${enc(id)}/latest`
  )
)

export const getNodeLoadavg = cache((cluster: string, id: string) =>
  request<LoadavgPoint[]>(
    `/api/clusters/${enc(cluster)}/nodes/${enc(id)}/loadavg?since=${Date.now() - 3_600_000}`
  )
)

export const getOverview = cache((cluster: string) =>
  request<Overview>(`/api/clusters/${enc(cluster)}/overview`)
)

export const getTests = cache((cluster: string) =>
  request<Test[]>(`/api/clusters/${enc(cluster)}/tests`)
)

export const getTest = cache((cluster: string, id: string) =>
  request<Test>(`/api/clusters/${enc(cluster)}/tests/${enc(id)}`)
)

export const getTestTelemetry = cache((cluster: string, id: string) =>
  request<Telemetry>(`/api/clusters/${enc(cluster)}/tests/${enc(id)}/telemetry`)
)

export const getTestStats = cache((cluster: string, id: string) =>
  request<TestStats>(`/api/clusters/${enc(cluster)}/tests/${enc(id)}/stats`)
)

export const getTestNodes = cache((cluster: string, id: string) =>
  request<NodeRun[]>(`/api/clusters/${enc(cluster)}/tests/${enc(id)}/nodes`)
)

export const getTestLog = cache((cluster: string, id: string) =>
  request<LogLine[]>(`/api/clusters/${enc(cluster)}/tests/${enc(id)}/log`)
)

export const getScripts = cache((cluster: string) =>
  request<ScriptList>(`/api/clusters/${enc(cluster)}/scripts`)
)

// A file of the scripts directory, or why it cannot be shown (binary, too large, gone).
export type ScriptFileResult =
  ({ ok: true } & ScriptContent) | { ok: false; status: number; error: string }

export async function getScriptFile(
  cluster: string,
  path: string
): Promise<ScriptFileResult> {
  let res: Response
  try {
    res = await fetch(
      `${base}/api/clusters/${enc(cluster)}/scripts/file?path=${enc(path)}`,
      { cache: "no-store", headers: await authHeaders() }
    )
  } catch (error) {
    throw new ApiUnavailableError(`xcale server is unreachable (${base})`, {
      cause: error,
    })
  }
  if (res.status === 401) throw new ApiUnauthorizedError("not signed in")
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok)
    return {
      ok: false,
      status: res.status,
      error: data.error ?? "cannot read the file",
    }
  return { ok: true, ...(data as ScriptContent) }
}

export class ApiError extends Error {}

// Mutations are called from Server Actions only: the browser never talks to the API.
export async function apiMutate<T>(
  method: "POST" | "DELETE" | "PUT",
  path: string,
  body?: unknown
): Promise<T> {
  // a Buffer or Uint8Array is sent as the raw bytes of a file, anything else as JSON
  const raw = body instanceof Uint8Array
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": raw ? "application/octet-stream" : "application/json",
      ...(await authHeaders()),
    },
    body:
      body === undefined
        ? undefined
        : raw
          ? Buffer.from(body)
          : JSON.stringify(body),
    cache: "no-store",
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 401) throw new ApiUnauthorizedError("not signed in")
  if (!res.ok)
    throw new ApiError(data.error ?? `request failed (${res.status})`)
  return data as T
}
