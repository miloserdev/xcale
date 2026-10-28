"use client"

import * as React from "react"
import { PlusIcon } from "lucide-react"

import { AgentToken } from "@/components/agent-token"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

// Nodes are not created by hand: the agent on a machine names itself and joins the cluster
// with the token of the cluster. The dialog shows how to start it.
export function AddNodeDialog({
  cluster,
  variant = "default",
}: {
  cluster: string
  variant?: "default" | "outline"
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant={variant} />}>
        <PlusIcon />
        Add node
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a node</DialogTitle>
          <DialogDescription>
            Start the agent on the machine. It names itself (by default with its
            host name) and joins the cluster with the cluster token; the node
            appears in the list when it connects and stays there while it is
            offline.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <code className="rounded-md bg-muted p-2 font-mono text-xs break-all">
            xcale-agent --url wss://&lt;xcale server&gt;/agent --cluster {cluster}{" "}
            [--name node-01] --token &lt;token&gt;
          </code>
          <AgentToken cluster={cluster} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
