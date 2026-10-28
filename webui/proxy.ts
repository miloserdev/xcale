import { NextResponse, type NextRequest } from "next/server"

import { sessionCookie } from "@/lib/session"

// Early gate: no session cookie, no pages. The cookie itself is validated by the
// xcale server on every API call (an expired session ends up on /login as well).
export function proxy(request: NextRequest) {
  if (request.cookies.has(sessionCookie)) return NextResponse.next()
  const login = new URL("/login", request.url)
  const target = request.nextUrl.pathname + request.nextUrl.search
  if (target !== "/") login.searchParams.set("next", target)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
}
