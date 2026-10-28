import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"

import { bus } from "./bus.ts"
import type { Store } from "./db.ts"
import { nameProblem } from "./names.ts"
import {
  isRecord,
  parseAgentMessage,
  parseHello,
  parseSample,
  type ErrorMessage,
  type FileChunk,
  type Forget,
  type RunAck,
  type RunCommand,
  type RunEvent,
  type RunStatus,
  type StopCommand,
  type SyncMessage,
  type Welcome,
} from "./protocol.ts"
import { buildManifest, resolveFile, type Manifest } from "./scripts.ts"

const HELLO_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 15_000
const SAMPLE_INTERVAL_MS = 1000
// Samples further than this from the server clock use the server time instead.
const MAX_CLOCK_SKEW_MS = 5 * 60_000
// An agent that loses the connection during a test keeps it running for 60 s and resends
// the output when it is back; the server waits a little longer than the agent does.
// The agent names itself "<cluster>.<node>" and proves that it belongs to the cluster with the
// token of the cluster. A node that is new to the cluster is registered on its first
// connection and stays in the cluster while it is offline. Returns the problem as text.
function authenticateAgent(store: Store, id: string, token: string) {
  const dot = id.indexOf(".")
  const cluster = dot > 0 ? id.slice(0, dot) : ""
  const name = dot > 0 ? id.slice(dot + 1) : ""
  if (nameProblem(cluster) || nameProblem(name))
    return "bad node id (ids look like <cluster>.<node>, names: letters, digits, _ and -)"
  if (!store.clusterExists(cluster)) return "unknown cluster"
  if (!store.checkClusterToken(cluster, token)) return "wrong cluster token"
  if (store.createNode({ id, clusterId: cluster, name }))
    console.log(`node ${id} registered in cluster ${cluster}`)
  return store.getNode(id)!
}

const RECONNECT_GRACE_MS = Number(process.env.XCALE_RECONNECT_GRACE_MS ?? 75_000)
const SYNC_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 20_000
const CHUNK_BYTES = 192 * 1024

type SyncResult = { ok: true; version: string } | { ok: false; error: string }

type Conn = {
  ws: WebSocket
  nodeId: string
  clusterId: string
  sync: {
    id: string
    manifest: Manifest
    promise: Promise<SyncResult>
    finish: (result: SyncResult) => void
  } | null
}

export type RunResult = { status: RunStatus; error?: string }

type RunHandle = {
  testId: string
  nodeId: string
  onScript: (script: string, event: "start" | "exit", code?: number) => void
  onLine: (script: string, line: string) => void
  finish: (result: RunResult) => void
  timers: Set<ReturnType<typeof setTimeout>>
}

const conns = new Map<string, Conn>()
const runs = new Map<string, RunHandle>() // "<test id>|<node id>"
const runKey = (testId: string, nodeId: string) => `${testId}|${nodeId}`

type Outgoing =
  | Welcome
  | ErrorMessage
  | SyncMessage
  | FileChunk
  | RunCommand
  | StopCommand
  | RunAck
  | Forget

function send(ws: WebSocket, message: Outgoing) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

const sendAsync = (ws: WebSocket, message: Outgoing) =>
  new Promise<void>((resolve, reject) =>
    ws.readyState === WebSocket.OPEN
      ? ws.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()))
      : reject(new Error("connection closed"))
  )

// Drops the connection of an agent whose node was removed.
export function disconnectNode(nodeId: string, reason: string) {
  conns.get(nodeId)?.ws.close(4410, reason)
  conns.delete(nodeId)
}

export function isNodeOnline(nodeId: string) {
  return conns.has(nodeId)
}

// The address the agent connected from. Behind a reverse proxy it is in X-Forwarded-For,
// trusted only when XCALE_TRUST_PROXY=true.
function remoteAddress(req: IncomingMessage) {
  const forwarded =
    process.env.XCALE_TRUST_PROXY === "true"
      ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
      : ""
  const raw = forwarded || req.socket.remoteAddress || ""
  return raw.replace(/^::ffff:/, "").slice(0, 64) || null
}

// --- syncing the scripts directory of a cluster to a node ---

// Sends the manifest and the files the agent asks for. A sync that is already running is
// joined; a script change during it is picked up by calling syncNode again afterwards.
export function syncNode(store: Store, nodeId: string): Promise<SyncResult> {
  const conn = conns.get(nodeId)
  if (!conn) return Promise.resolve({ ok: false, error: "the agent is not connected" })
  if (conn.sync) return conn.sync.promise

  let manifest: Manifest
  try {
    manifest = buildManifest(conn.clusterId)
  } catch (error) {
    const message = (error as Error).message
    store.setSyncState(nodeId, "failed", { error: message })
    return Promise.resolve({ ok: false, error: message })
  }

  const id = randomBytes(6).toString("hex")
  let finish!: (result: SyncResult) => void
  const promise = new Promise<SyncResult>((resolve) => {
    finish = (result) => {
      if (conn.sync?.id !== id) return
      clearTimeout(timer)
      conn.sync = null
      if (result.ok) store.setSyncState(nodeId, "synced", { version: result.version })
      else store.setSyncState(nodeId, "failed", { error: result.error })
      resolve(result)
    }
  })
  const timer = setTimeout(() => finish({ ok: false, error: "the sync timed out" }), SYNC_TIMEOUT_MS)
  conn.sync = { id, manifest, promise, finish }
  store.setSyncState(nodeId, "syncing")
  send(conn.ws, { type: "sync", id, version: manifest.version, files: manifest.files })
  return promise
}

// Starts a sync on every node of the cluster that is online (after the scripts changed).
export function syncCluster(store: Store, clusterId: string) {
  store.markClusterOutdated(clusterId)
  for (const node of store.listNodes(clusterId)) {
    if (!conns.has(node.id)) continue
    // a sync that was already running carries the previous version: once more if needed
    void syncNode(store, node.id).then((result) => {
      let current: string | null = null
      try {
        current = buildManifest(clusterId).version
      } catch {
        // the directory is too large; the sync above reported it
      }
      if (result.ok && current && result.version !== current) void syncNode(store, node.id)
    })
  }
}

async function sendFiles(conn: Conn, paths: string[]) {
  const sync = conn.sync
  if (!sync) return
  const known = new Map(sync.manifest.files.map((f) => [f.path, f]))
  for (const path of paths) {
    const file = known.get(path)
    if (!file) return sync.finish({ ok: false, error: `the agent asked for an unknown file: ${path}` })
    let content: Buffer
    try {
      content = readFileSync(resolveFile(conn.clusterId, path))
    } catch {
      return sync.finish({ ok: false, error: `cannot read ${path}` })
    }
    if (content.length !== file.size)
      return sync.finish({ ok: false, error: `${path} changed during the sync, try again` })
    for (let offset = 0; offset === 0 || offset < content.length; offset += CHUNK_BYTES) {
      const part = content.subarray(offset, offset + CHUNK_BYTES)
      await sendAsync(conn.ws, {
        type: "file",
        id: sync.id,
        path,
        last: offset + CHUNK_BYTES >= content.length,
        data: part.toString("base64"),
      })
    }
  }
}

// --- running a test on a node ---

// Runs the scripts of a test on a node one after another and resolves when the agent
// reports the end (or the node is lost for longer than the grace period).
export function runOnNode(
  store: Store,
  opts: {
    testId: string
    nodeId: string
    scripts: string[]
    env: Record<string, string>
    onScript: RunHandle["onScript"]
    onLine: RunHandle["onLine"]
    signal: AbortSignal
  }
): Promise<RunResult> {
  const conn = conns.get(opts.nodeId)
  if (!conn) {
    store.finishRun(opts.testId, opts.nodeId, "failed", "the agent is not connected")
    return Promise.resolve({ status: "failed", error: "the agent is not connected" })
  }

  const key = runKey(opts.testId, opts.nodeId)
  store.startRun(opts.testId, opts.nodeId)

  return new Promise<RunResult>((resolve) => {
    const handle: RunHandle = {
      testId: opts.testId,
      nodeId: opts.nodeId,
      onScript: opts.onScript,
      onLine: opts.onLine,
      timers: new Set(),
      finish: (result) => {
        if (runs.get(key) !== handle) return
        runs.delete(key)
        handle.timers.forEach(clearTimeout)
        store.finishRun(opts.testId, opts.nodeId, result.status, result.error)
        resolve(result)
      },
    }
    runs.set(key, handle)

    const stop = () => {
      const current = conns.get(opts.nodeId)
      if (!current) return handle.finish({ status: "stopped" })
      send(current.ws, { type: "stop", id: opts.testId })
      // an agent that does not answer must not keep the test hanging
      handle.timers.add(setTimeout(() => handle.finish({ status: "stopped" }), STOP_TIMEOUT_MS))
    }
    if (opts.signal.aborted) return stop()
    opts.signal.addEventListener("abort", stop, { once: true })

    send(conn.ws, { type: "run", id: opts.testId, scripts: opts.scripts, env: opts.env })
  })
}

function handleRunEvent(store: Store, conn: Conn, event: RunEvent) {
  const handle = runs.get(runKey(event.id, conn.nodeId))
  if (!handle) {
    send(conn.ws, { type: "forget", id: event.id })
    return
  }
  const last = store.runSeq(event.id, conn.nodeId) ?? 0
  if (event.seq > last) {
    store.advanceRun(event.id, conn.nodeId, event.seq)
    const script = event.script ?? ""
    if (event.event === "output") event.lines?.forEach((line) => handle.onLine(script, line))
    else if (event.event === "script_start") handle.onScript(script, "start")
    else if (event.event === "script_exit") handle.onScript(script, "exit", event.code)
    else if (event.event === "finished")
      handle.finish({ status: event.status ?? "failed", error: event.error })
  }
  send(conn.ws, { type: "run_ack", id: event.id, seq: event.seq })
}

// A lost connection does not end the test at once: the agent keeps the scripts running.
function waitForAgent(nodeId: string) {
  for (const handle of runs.values()) {
    if (handle.nodeId !== nodeId) continue
    handle.timers.add(
      setTimeout(
        () => handle.finish({ status: "lost", error: "lost connection to the agent" }),
        RECONNECT_GRACE_MS
      )
    )
  }
}

function agentIsBack(store: Store, conn: Conn, announced: { id: string; seq: number }[]) {
  const known = new Set(announced.map((r) => r.id))
  for (const handle of runs.values()) {
    if (handle.nodeId !== conn.nodeId) continue
    handle.timers.forEach(clearTimeout)
    handle.timers.clear()
    // the agent has no record of this test: it never started or was already forgotten
    if (!known.has(handle.testId))
      handle.finish({ status: "lost", error: "the agent lost the test" })
  }
  for (const run of announced) {
    const handle = runs.get(runKey(run.id, conn.nodeId))
    if (handle) send(conn.ws, { type: "run_ack", id: run.id, seq: store.runSeq(run.id, conn.nodeId) ?? 0 })
    else send(conn.ws, { type: "forget", id: run.id })
  }
}

export function attachAgentServer(http: Server, store: Store) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost")
    if (pathname !== "/agent") {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let conn: Conn | null = null
    let sensorIds = new Set<string>()
    let alive = true

    const helloTimer = setTimeout(() => {
      if (!conn) ws.close(4408, "hello timeout")
    }, HELLO_TIMEOUT_MS)

    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, PING_INTERVAL_MS)

    ws.on("pong", () => {
      alive = true
    })

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      alive = true
      if (isBinary) {
        ws.close(4400, "text frames only")
        return
      }
      let data: unknown
      try {
        data = JSON.parse(raw.toString())
      } catch {
        ws.close(4400, "invalid json")
        return
      }

      if (!conn) {
        const hello = parseHello(data)
        if (typeof hello === "string") {
          send(ws, { type: "error", message: hello })
          ws.close(4400, hello)
          return
        }
        const node = authenticateAgent(store, hello.node, hello.token)
        if (typeof node === "string") {
          // the agent only hears "unauthorized"; the reason stays in the node log
          console.log(`agent rejected: "${hello.node.slice(0, 80)}": ${node}`)
          send(ws, { type: "error", message: "unauthorized" })
          ws.close(4401, "unauthorized")
          return
        }
        conns.get(node.id)?.ws.close(4409, "replaced by a new connection")
        const current: Conn = { ws, nodeId: node.id, clusterId: node.cluster_id, sync: null }
        conn = current
        conns.set(node.id, current)
        sensorIds = new Set(hello.sensors.map((s) => s.id))
        const ip = remoteAddress(req)
        store.markSeen(node.id, hello.version, hello.info, hello.sensors, ip, hello.mac)
        send(ws, { type: "welcome", interval_ms: SAMPLE_INTERVAL_MS })
        console.log(
          `agent ${node.id} connected from ${ip ?? "?"} (v${hello.version}, ${hello.sensors.length} sensors)`
        )
        agentIsBack(store, current, hello.runs)
        // the node gets the current scripts as soon as it connects
        void syncNode(store, node.id)
        return
      }

      if (isRecord(data) && data.type === "sample") {
        const sample = parseSample(data)
        if (typeof sample === "string") return
        const now = Date.now()
        const ts = Math.abs(sample.ts - now) <= MAX_CLOCK_SKEW_MS ? sample.ts : now
        const values = Object.fromEntries(
          Object.entries(sample.values).filter(([id]) => sensorIds.has(id))
        )
        if (Object.keys(values).length) {
          store.insertSamples(conn.nodeId, ts, values)
          bus.emit("sample", conn.nodeId, ts, values)
        }
        store.touch(conn.nodeId)
        return
      }

      const message = parseAgentMessage(data)
      if (typeof message === "string") return
      if (message.type === "run") return handleRunEvent(store, conn, message)

      // sync_need / sync_done / sync_failed belong to the sync in progress
      const sync = conn.sync
      if (!sync || sync.id !== message.id) return
      if (message.type === "sync_need") {
        sendFiles(conn, message.paths).catch((error) =>
          sync.finish({ ok: false, error: `sending files failed: ${(error as Error).message}` })
        )
      } else if (message.type === "sync_done") {
        sync.finish(
          message.version === sync.manifest.version
            ? { ok: true, version: message.version }
            : { ok: false, error: "the node reports a different version, try again" }
        )
      } else if (message.type === "sync_failed") {
        sync.finish({ ok: false, error: message.error })
      }
    })

    ws.on("close", () => {
      clearTimeout(helloTimer)
      clearInterval(pingTimer)
      if (conn && conns.get(conn.nodeId) === conn) {
        conns.delete(conn.nodeId)
        conn.sync?.finish({ ok: false, error: "the connection was lost during the sync" })
        waitForAgent(conn.nodeId)
        console.log(`agent ${conn.nodeId} disconnected`)
      }
    })

    ws.on("error", (error: Error) => {
      console.error("agent socket error:", error.message)
    })
  })
}
