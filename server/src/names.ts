// Names of clusters and nodes: like file and directory names on Linux, without the dot
// (the dot separates cluster and node in a node id, "<cluster>.<node>").
export const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

// would collide with routes of the web UI
const reserved = new Set(["api", "login", "_next"])

// A message describing the problem, or null when the name is fine.
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !namePattern.test(name))
    return "use 1-64 characters: letters, digits, _ and -, not starting with -"
  if (reserved.has(name.toLowerCase())) return `"${name}" is reserved`
  return null
}

export function assertName(name: unknown, what: string): asserts name is string {
  const problem = nameProblem(name)
  if (problem) throw new Error(`invalid ${what} name: ${problem}`)
}
