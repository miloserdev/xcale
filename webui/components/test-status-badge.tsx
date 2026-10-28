import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import type { TestStatus } from "@/lib/types"

const variants: Record<
  TestStatus,
  { variant: React.ComponentProps<typeof Badge>["variant"]; className?: string }
> = {
  queued: { variant: "outline" },
  running: { variant: "default", className: "animate-pulse" },
  passed: { variant: "secondary" },
  failed: { variant: "destructive" },
  aborted: { variant: "ghost", className: "text-muted-foreground" },
}

export function TestStatusBadge({ status }: { status: TestStatus }) {
  const { variant, className } = variants[status]
  return (
    <Badge variant={variant} className={cn(className)}>
      {status}
    </Badge>
  )
}
