import { randomBytes } from "node:crypto"

import { isNodeOnline, runOnNode, syncNode } from "./agents.ts"
import type { NodeRow, Store, TestRow } from "./db.ts"
import { isRecord } from "./protocol.ts"
import { buildManifest, fileExists, pathProblem } from "./scripts.ts"

const MAX_LOG_LINES = 20_000

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const hhmmss = () => new Date().toISOString().slice(11, 19)

// --- input validation ---

export type NewTest = {
  name: string
  scriptsPaths: string[]
  nodeIds: string[]
  configs: Record<string, string>
  startedBy: string
}

export function parseNewTest(
  store: Store,
  clusterId: string,
  body: unknown,
  startedBy: string
): NewTest {
  if (!isRecord(body)) throw new HttpError(400, "expected a JSON object")
  const str = (v: unknown, message: string, max: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > max)
      throw new HttpError(400, message)
    return v.trim()
  }
  const list = (v: unknown, message: string, max: number) => {
    if (!Array.isArray(v) || !v.length || v.length > max)
      throw new HttpError(400, message)
    return v.map((item) => str(item, message, 200))
  }

  const name = str(body.name, "enter a test name (up to 100 characters)", 100)
  const scriptsPaths = list(body.scriptsPaths, "select at least one script (up to 20)", 20)
  for (const path of scriptsPaths) {
    const problem = pathProblem(path)
    if (problem) throw new HttpError(400, `invalid script name ${path}: ${problem}`)
    if (!fileExists(clusterId, path)) throw new HttpError(400, `script not found: ${path}`)
  }

  const nodeIds = [...new Set(list(body.nodeIds, "select at least one node", 100))]
  for (const id of nodeIds) {
    if (store.getNode(id)?.cluster_id !== clusterId)
      throw new HttpError(400, `node is not in this cluster: ${id}`)
  }

  const configs: Record<string, string> = {}
  if (body.configs !== undefined) {
    if (!isRecord(body.configs)) throw new HttpError(400, "bad configs")
    for (const [key, value] of Object.entries(body.configs)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || typeof value !== "string" || value.length > 200)
        throw new HttpError(400, `bad config: ${key}`)
      configs[key] = value
    }
  }

  return { name, scriptsPaths, nodeIds, configs, startedBy }
}

// --- runner ---

export class Runner {
  store: Store
  private running = new Map<string, AbortController>()
  private busy = new Set<string>() // nodes occupied by a running test

  constructor(store: Store) {
    this.store = store
  }

  // Tests left "running" by a previous process cannot be resumed.
  recover() {
    for (const test of this.store.listTestsByStatus("running")) {
      for (const node of this.store.testNodes(test))
        if (node.status === "running") this.store.finishRun(test.id, node.nodeId, "lost", "server restarted")
      this.store.appendLog(test.id, `[${hhmmss()}] runner: server restarted, test lost`)
      this.store.finishTest(test.id, "failed", null)
    }
    this.pump()
  }

  create(clusterId: string, input: NewTest): TestRow {
    const test: TestRow = {
      id: `t-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`,
      clusterId,
      ...input,
      metrics: [],
      status: "queued",
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
    }
    this.store.createTest(test)
    this.pump()
    return this.store.getTestById(test.id)!
  }

  // Resolves once none of the tests is running or waiting any more; false on timeout.
  async waitUntilFinished(ids: string[], timeoutMs: number) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const left = ids.filter((id) => {
        const status = this.store.getTestById(id)?.status
        return status === "running" || status === "queued"
      })
      if (!left.length) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  rerun(source: TestRow, startedBy: string) {
    return this.create(source.clusterId, {
      name: source.name,
      scriptsPaths: source.scriptsPaths,
      nodeIds: source.nodeIds,
      configs: source.configs,
      startedBy,
    })
  }

  stop(id: string): "aborting" | "aborted" | "finished" | "not-found" {
    const test = this.store.getTestById(id)
    if (!test) return "not-found"
    const controller = this.running.get(id)
    if (controller) {
      controller.abort()
      return "aborting"
    }
    if (test.status === "queued") {
      this.store.appendLog(id, `[${hhmmss()}] runner: removed from the queue`)
      this.store.finishTest(id, "aborted", null)
      return "aborted"
    }
    return "finished"
  }

  // Starts every queued test whose nodes are all free, oldest first.
  private pump() {
    for (const test of this.store.listTestsByStatus("queued")) {
      if (this.running.has(test.id)) continue
      if (test.nodeIds.some((id) => this.busy.has(id))) continue
      this.start(test)
    }
  }

  private start(test: TestRow) {
    const controller = new AbortController()
    this.running.set(test.id, controller)
    test.nodeIds.forEach((id) => this.busy.add(id))
    this.store.markRunning(test.id)
    this.execute(test, controller.signal)
      .catch((error) => {
        console.error(`test ${test.id} crashed:`, error)
        this.store.appendLog(test.id, `[${hhmmss()}] runner: internal error: ${error}`)
        this.store.finishTest(test.id, "failed", null)
      })
      .finally(() => {
        this.running.delete(test.id)
        test.nodeIds.forEach((id) => this.busy.delete(id))
        this.pump()
      })
  }

  private async execute(test: TestRow, signal: AbortSignal) {
    let lines = 0
    const log = (who: string, text: string, nodeId: string | null = null) => {
      lines++
      if (lines > MAX_LOG_LINES) {
        if (lines === MAX_LOG_LINES + 1)
          this.store.appendLog(test.id, `[${hhmmss()}] runner: log truncated`)
        return
      }
      this.store.appendLog(test.id, `[${hhmmss()}] ${who}: ${text}`, nodeId)
    }

    const nodes = test.nodeIds.map((id) => this.store.getNode(id))
    log("runner", `test ${test.id} "${test.name}" started`)
    const outcomes = await Promise.all(
      nodes.map((target, i) =>
        target
          ? this.runOnTarget(test, target, signal, (who, text) => log(who, text, target.id))
          : (log("runner", `unknown node ${test.nodeIds[i]}`), false)
      )
    )

    const status = signal.aborted ? "aborted" : outcomes.every(Boolean) ? "passed" : "failed"
    const startedAt = this.store.getTestById(test.id)?.startedAt ?? test.startedAt
    const result = this.store.computeResult(test.nodeIds, startedAt, Date.now())
    // the closing line first: finishing the test ends the live streams
    log("runner", `test ${status}`)
    this.store.finishTest(test.id, status, result)
  }

  // The agent of the node does the work: first the scripts directory is synced, then the
  // scripts run one after another; the first failure ends the test on this node only.
  private async runOnTarget(
    test: TestRow,
    target: NodeRow,
    signal: AbortSignal,
    log: (who: string, text: string) => void
  ) {
    const node = target.name
    if (!isNodeOnline(target.id)) {
      log(node, "the agent is not connected")
      this.store.finishRun(test.id, target.id, "failed", "the agent is not connected")
      return false
    }

    // a sync that was already running may carry an older version of the directory
    let sync = await syncNode(this.store, target.id)
    const current = () => buildManifest(test.clusterId).version
    if (sync.ok && sync.version !== current()) sync = await syncNode(this.store, target.id)
    if (!sync.ok) {
      log(node, `sync failed: ${sync.error}`)
      this.store.finishRun(test.id, target.id, "failed", `sync failed: ${sync.error}`)
      return false
    }
    log(node, `scripts are in sync (${sync.version})`)
    if (signal.aborted) {
      this.store.finishRun(test.id, target.id, "stopped")
      return false
    }

    const env: Record<string, string> = {
      XCALE_TEST_ID: test.id,
      XCALE_CLUSTER: test.clusterId,
      XCALE_NODE: node,
    }
    for (const [key, value] of Object.entries(test.configs)) env[`XCALE_${key.toUpperCase()}`] = value

    let failedScript: string | undefined
    const result = await runOnNode(this.store, {
      testId: test.id,
      nodeId: target.id,
      scripts: test.scriptsPaths,
      env,
      signal,
      onScript: (script, event, code) => {
        log(node, event === "start" ? `$ ${script}` : `${script} exited with ${code}`)
        if (event === "exit" && code) failedScript = `${script} exited with ${code}`
      },
      onLine: (script, line) => log(`${node} ${script}`, line),
    })
    if (result.status === "passed") return true
    // the agent reports only that a script failed: say which one and how
    if (!result.error && failedScript) this.store.finishRun(test.id, target.id, result.status, failedScript)
    if (result.error) log(node, result.error)
    else log(node, `the test ${result.status} on this node`)
    return false
  }
}
