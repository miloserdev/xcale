import type { Node } from "@/lib/types"

export function formatResult(
  result: { maxTemp?: number | null; maxPower?: number | null } | null
) {
  if (result?.maxTemp == null && result?.maxPower == null) return "—"
  const part = (v: number | null | undefined, unit: string) =>
    v == null ? "—" : `${v} ${unit}`
  return `max ${part(result.maxTemp, "°C")} · max ${part(result.maxPower, "W")}`
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return undefined
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

export function formatUptime(bootTs: number | undefined, now = Date.now()) {
  if (!bootTs) return "—"
  const minutes = Math.max(0, Math.floor((now - bootTs) / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`
}

// The names of the nodes; a long list is cut after `limit` names.
export function nodeNames(
  nodes: Pick<Node, "id" | "name">[],
  ids: string[],
  limit = 3
) {
  const names = ids
    .slice(0, limit)
    .map((id) => nodes.find((node) => node.id === id)?.name ?? id)
    .join(", ")
  return ids.length > limit ? `${names} and ${ids.length - limit} more` : names
}
