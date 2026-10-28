import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-medium">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This cluster, node or test does not exist.
        </p>
        <Button nativeButton={false} render={<Link href="/" />}>
          Back to start
        </Button>
      </div>
    </div>
  )
}
