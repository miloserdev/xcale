import { cookies } from "next/headers"

import { sessionCookie } from "@/lib/session"

const base = process.env.XCALE_API ?? "http://127.0.0.1:4000"

// Hands the sensor readings of a test (?format=csv|json, ?nodes=a,b) to the browser as a
// download: a zip with a CSV per node, or one JSON. The bearer token is added here, the browser only has the cookie.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ cluster: string; id: string }> }
) {
  const { cluster, id } = await params
  const token = (await cookies()).get(sessionCookie)?.value
  if (!token) return new Response("not signed in", { status: 401 })

  const query = new URL(request.url).searchParams
  const upstreamQuery = new URLSearchParams()
  for (const key of ["format", "nodes"]) {
    const value = query.get(key)
    if (value) upstreamQuery.set(key, value)
  }

  let upstream: Response
  try {
    upstream = await fetch(
      `${base}/api/clusters/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(id)}/export?${upstreamQuery}`,
      { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }
    )
  } catch {
    return new Response("xcale server is unreachable", { status: 502 })
  }
  const headers = new Headers()
  for (const name of ["content-type", "content-disposition"]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}
