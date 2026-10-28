"use client"

import * as React from "react"

import type { Node, ClusterSummary } from "@/lib/types"

type ClusterContextValue = {
  clusters: ClusterSummary[]
  activeCluster: { id: string; name: string; nodes: Node[] }
}

const ClusterContext = React.createContext<ClusterContextValue | null>(null)

export function useCluster() {
  const context = React.useContext(ClusterContext)
  if (!context) {
    throw new Error("useCluster must be used within a ClusterProvider.")
  }
  return context
}

// The active cluster comes from the URL (`/<cluster>/...`); the layout loads its data.
export function ClusterProvider({
  clusters,
  activeCluster,
  children,
}: ClusterContextValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ clusters, activeCluster }),
    [clusters, activeCluster]
  )
  return (
    <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
  )
}
