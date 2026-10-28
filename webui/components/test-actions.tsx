"use client"

import * as React from "react"
import Link from "next/link"
import { CopyIcon, RotateCcwIcon, SquareIcon, Trash2Icon } from "lucide-react"

import {
  deleteTestAction,
  rerunTestAction,
  stopTestAction,
  type ActionState,
} from "@/app/[cluster]/tests/actions"
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
import type { Test } from "@/lib/types"

function Confirm({
  label,
  icon,
  title,
  description,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string
  icon: React.ReactNode
  title: string
  description: string
  confirmLabel: string
  disabled: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={<Button variant="destructive" disabled={disabled} />}
      >
        {icon}
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function TestActions({
  cluster,
  test,
}: {
  cluster: string
  test: Test
}) {
  const [pending, startTransition] = React.useTransition()
  const [error, setError] = React.useState<string>()
  const active = test.status === "running" || test.status === "queued"

  function run(action: () => Promise<ActionState>) {
    setError(undefined)
    startTransition(async () => {
      const result = await action()
      if (result?.error) setError(result.error)
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {active ? (
        <Confirm
          label="Stop"
          icon={<SquareIcon />}
          title="Stop this test?"
          description={
            test.status === "queued"
              ? "The test is waiting in the queue and will be cancelled."
              : "The scripts are terminated on every node and the test is marked as aborted."
          }
          confirmLabel="Stop test"
          disabled={pending}
          onConfirm={() => run(() => stopTestAction(cluster, test.id))}
        />
      ) : (
        <>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => run(() => rerunTestAction(cluster, test.id))}
          >
            <RotateCcwIcon />
            Rerun
          </Button>
          <Confirm
            label="Delete"
            icon={<Trash2Icon />}
            title="Delete this test?"
            description="The test and its log are removed. Sensor history stays."
            confirmLabel="Delete"
            disabled={pending}
            onConfirm={() => run(() => deleteTestAction(cluster, test.id))}
          />
        </>
      )}
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link href={`/${cluster}/tests/new?from=${test.id}`} />}
      >
        <CopyIcon />
        Duplicate
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  )
}
