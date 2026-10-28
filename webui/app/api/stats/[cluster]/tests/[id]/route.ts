import { cookies } from "next/headers"

import { sessionCookie } from "@/lib/session"

const base = process.env.XCALE_API ?? "http://127.0.0.1:4000"

// min / avg / max of the sensors of a test, for the table that follows a running test.
// The bearer token is added here, the browser only has the session cookie.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cluster: string; id: string }> }
) {
  const { cluster, id } = await params
  const token = (await cookies()).get(sessionCookie)?.value
  if (!token) return new Response("not signed in", { status: 401 })
  try {
    const upstream = await fetch(
      `${base}/api/clusters/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(id)}/stats`,
      { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }
    )
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    })
  } catch {
    return new Response("xcale server is unreachable", { status: 502 })
  }
}
