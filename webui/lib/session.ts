export const sessionCookie = "xcale_session"

// Only same-site paths may be used as the post-login target (no open redirects).
export function safeNext(next: string | undefined | null) {
  return next &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.includes("\\")
    ? next
    : "/"
}
