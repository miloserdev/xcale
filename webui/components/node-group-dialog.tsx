"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { TagIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { setNodesGroupAction } from "@/lib/cluster-actions"

// Puts the selected nodes into a group of the cluster (an existing one or a new one);
// an empty name takes them out of their group.
export function NodeGroupDialog({
  cluster,
  ids,
  groups,
  onDone,
}: {
  cluster: string
  ids: string[]
  groups: string[]
  onDone?: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [group, setGroup] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()

  function save() {
    setError(undefined)
    startTransition(async () => {
      const result = await setNodesGroupAction(cluster, ids, group)
      if (result?.error) return setError(result.error)
      setOpen(false)
      onDone?.()
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <TagIcon />
        Group
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Group of {ids.length} node(s)</DialogTitle>
          <DialogDescription>
            Pick an existing group or type a new name. Leave it empty to take
            the nodes out of their group.
          </DialogDescription>
        </DialogHeader>
        <form
          id="node-group-form"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
          className="flex flex-col gap-2"
        >
          <Input
            list="node-groups"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="rack-a"
            maxLength={64}
            aria-label="Group name"
            autoFocus
          />
          <datalist id="node-groups">
            {groups.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="submit" form="node-group-form" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
