"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

// Re-fetches the server components of the page while `enabled` (e.g. a test is running).
// Client state such as filters, sorting and scroll position is preserved.
export function AutoRefresh({
  enabled,
  intervalMs = 3000,
}: {
  enabled: boolean
  intervalMs?: number
}) {
  const router = useRouter()
  React.useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs, router])
  return null
}
