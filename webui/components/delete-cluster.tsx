"use client"

import * as React from "react"
import { Trash2Icon, TriangleAlertIcon } from "lucide-react"

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
import { deleteClusterAction } from "@/lib/cluster-actions"
import type { ClusterStats } from "@/lib/types"

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

export function DeleteCluster({ stats }: { stats: ClusterStats }) {
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const running = stats.activeTests > 0

  function confirm() {
    setOpen(false)
    setError(undefined)
    startTransition(async () => {
      // the user confirmed stopping the running tests when the warning was shown
      const result = await deleteClusterAction(stats.id, running)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger
          render={<Button variant="destructive" disabled={pending} />}
        >
          <Trash2Icon />
          Delete cluster
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete cluster {stats.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {plural(stats.nodes, "node", "nodes")} and{" "}
              {plural(stats.tests, "test", "tests")} with their logs and the
              sensor history. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {running && (
            <div
              role="alert"
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {plural(stats.activeTests, "test is", "tests are")} running or
                waiting. They will be stopped before the cluster is deleted.
              </span>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirm}>
              {running ? "Stop tests and delete" : "Delete cluster"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
