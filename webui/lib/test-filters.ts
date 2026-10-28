import type { Test, TestStatus } from "@/lib/types"

export const testStatuses: TestStatus[] = [
  "queued",
  "running",
  "passed",
  "failed",
  "aborted",
]

export type TestFilters = {
  q: string
  status: TestStatus[]
  node: string[]
  from: string // YYYY-MM-DD, UTC
  to: string
}

// Filters live in the URL: ?q=soak&status=failed,aborted&node=ts0-node-01&from=2026-10-01&to=2026-10-15
export function parseTestFilters(params: URLSearchParams): TestFilters {
  const list = (key: string) =>
    params.get(key)?.split(",").filter(Boolean) ?? []
  return {
    q: params.get("q") ?? "",
    status: list("status").filter((s): s is TestStatus =>
      testStatuses.includes(s as TestStatus)
    ),
    node: list("node"),
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  }
}

export function filterTests(tests: Test[], filters: TestFilters) {
  const q = filters.q.trim().toLowerCase()
  return tests.filter((test) => {
    if (q && !`${test.name} ${test.id}`.toLowerCase().includes(q)) return false
    if (filters.status.length && !filters.status.includes(test.status))
      return false
    if (
      filters.node.length &&
      !test.nodeIds.some((id) => filters.node.includes(id))
    )
      return false
    const day = test.startedAt.slice(0, 10)
    if (filters.from && day < filters.from) return false
    if (filters.to && day > filters.to) return false
    return true
  })
}

export function hasTestFilters(filters: TestFilters) {
  return Boolean(
    filters.q ||
    filters.status.length ||
    filters.node.length ||
    filters.from ||
    filters.to
  )
}
