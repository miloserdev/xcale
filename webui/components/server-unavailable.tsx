"use client"

import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"

export function ServerUnavailable({
  onRetry,
  detail,
}: {
  onRetry?: () => void
  detail?: string
}) {
  const router = useRouter()
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-medium">Can’t load data</h1>
        <p className="text-sm text-muted-foreground">
          The xcale server is not responding, returned an error or is older
          than the web UI. Check that it is running (restart it after an update)
          and try again.
        </p>
        {detail && (
          <p className="font-mono text-xs text-muted-foreground">{detail}</p>
        )}
        <Button onClick={() => (onRetry ? onRetry() : router.refresh())}>
          Try again
        </Button>
      </div>
    </div>
  )
}
