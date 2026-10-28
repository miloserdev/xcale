"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

// A button of the bulk toolbar. With `confirm` it asks first; `run` returns an error text
// (shown next to the buttons) or nothing, then the page data is reloaded.
export function BulkButton({
  label,
  icon,
  variant = "outline",
  confirm,
  disabled,
  run,
  onDone,
}: {
  label: string
  icon?: React.ReactNode
  variant?: "outline" | "destructive"
  confirm?: { title: string; description: string; action: string }
  disabled?: boolean
  run: () => Promise<{ error?: string } | null | undefined>
  onDone?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string>()

  function go() {
    setOpen(false)
    setError(undefined)
    startTransition(async () => {
      const result = await run()
      if (result?.error) setError(result.error)
      else onDone?.()
      router.refresh()
    })
  }

  return (
    <>
      {confirm ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger
            render={
              <Button variant={variant} size="sm" disabled={pending || disabled} />
            }
          >
            {icon}
            {label}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={variant === "destructive" ? "destructive" : "default"}
                onClick={go}
              >
                {confirm.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Button
          variant={variant}
          size="sm"
          disabled={pending || disabled}
          onClick={go}
        >
          {icon}
          {label}
        </Button>
      )}
      {error && <span className="text-sm text-destructive">{error}</span>}
    </>
  )
}
