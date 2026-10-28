import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"

export const authConfig = {
  // PAM service name: /etc/pam.d/<service>
  service: process.env.XCALE_PAM_SERVICE ?? "xcale",
  helper: process.env.XCALE_PAM_HELPER ?? resolve("pam/xcale-pam"),
  // accounts below this uid (root, system users) can never log in
  minUid: process.env.XCALE_MIN_UID ?? "1000",
  sessionMs: Number(process.env.XCALE_SESSION_HOURS ?? 12) * 3_600_000,
}

// POSIX-style names plus user@domain; anything else is rejected without asking PAM.
const usernamePattern = /^[A-Za-z0-9_.@-]{1,64}$/

export function validUsername(username: unknown): username is string {
  return typeof username === "string" && usernamePattern.test(username)
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url")
}

export type PamResult = "ok" | "rejected" | "error"

let active = 0
const waiting: (() => void)[] = []
const MAX_CONCURRENT = 4

async function slot<T>(fn: () => Promise<T>) {
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

// Asks the PAM helper (server/pam) whether the credentials are valid.
export function pamCheck(username: string, password: string) {
  if (!validUsername(username) || !password || /[\r\n\0]/.test(password) || password.length > 200)
    return Promise.resolve<PamResult>("rejected")

  return slot(
    () =>
      new Promise<PamResult>((resolveResult) => {
        const child = spawn(authConfig.helper, [authConfig.service, authConfig.minUid], {
          stdio: ["pipe", "ignore", "ignore"],
        })
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
        child.on("error", (error) => {
          console.error("pam helper failed to start:", error.message)
          clearTimeout(timer)
          resolveResult("error")
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          resolveResult(code === 0 ? "ok" : code === 1 ? "rejected" : "error")
        })
        child.stdin.on("error", () => {})
        child.stdin.end(`${username}\n${password}\n`)
      })
  )
}

// Failed logins per key (user name or client address); too many block the key for a while.
export class LoginThrottle {
  private entries = new Map<string, { count: number; first: number; until: number }>()
  private limit: number
  private windowMs: number
  private blockMs: number

  constructor(limit = 5, windowMs = 5 * 60_000, blockMs = 5 * 60_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.blockMs = blockMs
  }

  // Milliseconds until the key may try again, 0 when it is not blocked.
  blockedFor(key: string) {
    const entry = this.entries.get(key)
    return entry && entry.until > Date.now() ? entry.until - Date.now() : 0
  }

  fail(key: string) {
    const now = Date.now()
    let entry = this.entries.get(key)
    if (!entry || now - entry.first > this.windowMs) {
      entry = { count: 0, first: now, until: 0 }
      this.entries.set(key, entry)
    }
    entry.count++
    if (entry.count >= this.limit) entry.until = now + this.blockMs
    if (this.entries.size > 10_000) this.sweep()
  }

  reset(key: string) {
    this.entries.delete(key)
  }

  private sweep() {
    const now = Date.now()
    for (const [key, entry] of this.entries)
      if (entry.until < now && now - entry.first > this.windowMs) this.entries.delete(key)
  }
}
