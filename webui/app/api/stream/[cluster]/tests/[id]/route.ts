import { cookies } from "next/headers"

import { sessionCookie } from "@/lib/session"

const base = process.env.XCALE_API ?? "http://127.0.0.1:4000"

// Relays the live event stream of a test from the xcale server to the browser.
// The browser only has the httpOnly session cookie; the bearer token is added here.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ cluster: string; id: string }> }
) {
  const { cluster, id } = await params
  const token = (await cookies()).get(sessionCookie)?.value
  if (!token) return new Response("not signed in", { status: 401 })

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "text/event-stream",
  }
  // EventSource sends Last-Event-ID when it reconnects by itself
  const lastEventId = request.headers.get("last-event-id")
  if (lastEventId) headers["last-event-id"] = lastEventId
  const after = new URL(request.url).searchParams.get("after")

  let upstream: Response
  try {
    upstream = await fetch(
      `${base}/api/clusters/${encodeURIComponent(cluster)}/tests/${encodeURIComponent(id)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      { headers, cache: "no-store", signal: request.signal }
    )
  } catch {
    return new Response("xcale server is unreachable", { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel()
    return new Response(
      upstream.status === 401 ? "not signed in" : "unavailable",
      {
        status:
          upstream.status === 401 ? 401 : upstream.status === 404 ? 404 : 502,
      }
    )
  }

  // closing the browser connection aborts `request.signal`, which ends the upstream one
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  })
}
