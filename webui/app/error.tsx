"use client"

import { useEffect } from "react"

import { ServerUnavailable } from "@/components/server-unavailable"

// Last resort for errors thrown below the layouts (the layouts handle an
// unreachable server themselves).
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return <ServerUnavailable onRetry={retry} detail={error.digest} />
}
