"use server"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

import { sessionCookie, safeNext } from "@/lib/session"

export type LoginState = { error?: string } | null

const base = process.env.XCALE_API ?? "http://127.0.0.1:4000"

export async function loginAction(
  next: string,
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const h = await headers()
  // Known only behind a reverse proxy; lets the server limit guessing per address.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0].trim()

  let res: Response
  try {
    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
      body: JSON.stringify({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
      }),
      cache: "no-store",
    })
  } catch {
    return { error: "Login is temporarily unavailable." }
  }

  // The same message for a wrong user and a wrong password.
  if (res.status === 401) return { error: "Invalid username or password." }
  if (res.status === 429)
    return { error: "Too many attempts. Try again in a few minutes." }
  if (!res.ok) return { error: "Login is temporarily unavailable." }

  const { token, expiresAt } = (await res.json()) as {
    token: string
    expiresAt: number
  }
  const secure =
    process.env.XCALE_COOKIE_SECURE === "true" ||
    h.get("x-forwarded-proto") === "https"
  ;(await cookies()).set(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(expiresAt),
  })
  redirect(safeNext(next))
}

export async function logoutAction() {
  const store = await cookies()
  const token = store.get(sessionCookie)?.value
  if (token) {
    // best effort: the cookie is dropped even if the server cannot be reached
    await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => {})
  }
  store.delete(sessionCookie)
  redirect("/login")
}
