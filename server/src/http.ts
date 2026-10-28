import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { disconnectNode, isNodeOnline, syncCluster } from "./agents.ts"
import {
  LoginThrottle,
  authConfig,
  newSessionToken,
  pamCheck,
  validUsername,
} from "./auth.ts"
import type { NodeRow, Store, TestRow } from "./db.ts"
import { bus, type LogEntry, type NodeRun } from "./bus.ts"
import { zip } from "./zip.ts"
import { nameProblem } from "./names.ts"
import { sensorKey, sensorRefs, testCsv, testExportJson, testStats, testTelemetry } from "./telemetry.ts"
import { HttpError, parseNewTest, type Runner } from "./runner.ts"
import {
  ScriptsError,
  buildManifest,
  deleteEntry,
  ensureClusterDir,
  limits,
  readText,
  removeClusterDir,
  renameEntry,
  writeFileChecked,
} from "./scripts.ts"

type Point = { t: number; time: string } & Record<string, number | string>
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function nodeJson(store: Store, s: NodeRow) {
  return {
    id: s.id,
    name: s.name,
    online: isNodeOnline(s.id),
    lastSeen: s.last_seen,
    agentVersion: s.agent_version,
    lastIp: s.last_ip,
    lastMac: s.last_mac,
    group: s.group_name,
    syncStatus: s.sync_status,
    syncVersion: s.sync_version,
    syncError: s.sync_error,
    syncAt: s.sync_at,
    info: s.info,
    sensors: s.sensors,
  }
}

function testJson(t: TestRow) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    scriptsPaths: t.scriptsPaths,
    nodeIds: t.nodeIds,
    configs: t.configs,
    startedAt: new Date(t.startedAt).toISOString(),
    durationMs: t.finishedAt ? t.finishedAt - t.startedAt : null,
    startedBy: t.startedBy,
    result: t.result,
  }
}

const positive = (value: string | null, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Browsers cannot send mutating requests to this API cross-origin unless listed here.
// The web UI calls it from the Next.js server, which sends no Origin header.
const allowedOrigins = (process.env.XCALE_ORIGINS ?? "").split(",").filter(Boolean)

// A raw body (an uploaded or edited file).
function readRaw(req: IncomingMessage, limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      // an oversized upload is read to the end (so the 413 can be delivered) but not kept
      if (size > limit) tooLarge = true
      if (size > 8 * limit) return req.destroy()
      if (!tooLarge) chunks.push(chunk)
    })
    req.on("end", () => (tooLarge ? reject(new HttpError(413, "the file is too large")) : resolve(Buffer.concat(chunks))))
    req.on("error", reject)
  })
}

function readBody(req: IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new HttpError(413, "body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString()
      if (!text) return resolve(undefined)
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return reject(new HttpError(415, "content-type must be application/json"))
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, "invalid json"))
      }
    })
    req.on("error", reject)
  })
}

export function createHttpServer(store: Store, runner: Runner) {
  // `user` is the signed-in user name ("" on the public routes)
  type Context = { req: IncomingMessage; user: string }
  type Handler = (
    m: string[],
    url: URL,
    res: ServerResponse,
    body: unknown,
    ctx: Context
  ) => void | Promise<void>
  // `raw` routes receive the body as a Buffer instead of parsed JSON
  const routes: [string, RegExp, Handler, boolean][] = []
  const route =
    (method: string) =>
    (pattern: string, handler: Handler, raw = false) =>
      routes.push([method, new RegExp(`^${pattern}$`), handler, raw])
  // everything except these needs a session: `Authorization: Bearer <token>`
  const publicRoutes = new Set(["GET /api/health", "POST /api/auth/login"])
  const throttle = new LoginThrottle()

  store.purgeSessions()
  setInterval(() => store.purgeSessions(), 3_600_000).unref()

  const bearer = (req: IncomingMessage) => {
    const header = req.headers.authorization
    return header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
  }
  // The web UI forwards the browser address when it knows it (behind a reverse proxy);
  // the API itself listens on loopback only. "" when unknown.
  const forwardedAddress = (req: IncomingMessage) =>
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim().slice(0, 64)
  const get = route("GET")
  const post = route("POST")
  const put = route("PUT")
  const del = route("DELETE")
  const notFound = (res: ServerResponse) => json(res, 404, { error: "not found" })

  get("/api/health", (_m, _u, res) => json(res, 200, { ok: true }))

  get("/api/clusters", (_m, _u, res) =>
    json(
      res,
      200,
      store.listClusters().map((s) => ({
        id: s.id,
        name: s.name,
        nodeCount: s.node_count,
      }))
    )
  )

  // --- managing clusters and nodes ---

  get("/api/clusters/([^/]+)", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    json(res, 200, { id: cluster, name: cluster, ...store.clusterStats(cluster) })
  })

  post("/api/clusters", (_m, _u, res, body) => {
    const name = (body as { name?: unknown } | undefined)?.name
    const problem = nameProblem(name)
    if (problem) throw new HttpError(400, problem)
    if (store.clusterExists(name as string)) throw new HttpError(409, "a cluster with this name already exists")
    store.upsertCluster(name as string, name as string)
    ensureClusterDir(name as string)
    json(res, 201, { id: name, name })
  })

  // A cluster with running or waiting tests is only deleted with ?stop=true: the tests are
  // stopped first. Then its nodes, tests, logs and sensor history are removed.
  del("/api/clusters/([^/]+)", async ([cluster], url, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const active = store.listClusterTests(cluster, ["running", "queued"], 1000, "active")
    if (active.length) {
      if (url.searchParams.get("stop") !== "true")
        return json(res, 409, {
          error: `${active.length} test(s) are running or waiting`,
          activeTests: active.length,
        })
      active.forEach((t) => runner.stop(t.id))
      if (!(await runner.waitUntilFinished(active.map((t) => t.id), 30_000)))
        return json(res, 409, { error: "the tests did not stop in time, try again" })
    }
    // a test may have been started meanwhile
    if (store.clusterStats(cluster).activeTests > 0)
      return json(res, 409, { error: "a test was started meanwhile, try again" })
    store.listNodes(cluster).forEach((s) => disconnectNode(s.id, "cluster deleted"))
    const removed = store.deleteCluster(cluster)
    removeClusterDir(cluster)
    console.log(`cluster ${cluster} deleted (${removed.nodes} nodes, ${removed.tests} tests)`)
    json(res, 200, { ok: true, ...removed })
  })

  del("/api/clusters/([^/]+)/nodes/([^/]+)", ([cluster, id], _u, res) => {
    const node = store.getNode(id)
    if (!node || node.cluster_id !== cluster) return notFound(res)
    if (store.activeTestsOnNode(id) > 0)
      return json(res, 409, { error: "a test is running or waiting on this node, stop it first" })
    disconnectNode(id, "node removed")
    store.deleteNode(id)
    console.log(`node ${id} removed`)
    json(res, 200, { ok: true })
  })

  // body: { ids: string[], group: string | null }; a null or empty group ungroups the nodes
  put("/api/clusters/([^/]+)/nodes/group", ([cluster], _u, res, body) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const { ids, group } = (body ?? {}) as { ids?: unknown; group?: unknown }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      throw new HttpError(400, "ids must be a list of node ids")
    let name: string | null = null
    if (group !== null && group !== "") {
      const problem = nameProblem(group)
      if (problem) throw new HttpError(400, `group name: ${problem}`)
      name = group as string
    }
    json(res, 200, { ok: true, changed: store.setNodesGroup(cluster, ids, name) })
  })

  get("/api/clusters/([^/]+)/nodes", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    json(res, 200, store.listNodes(cluster).map((s) => nodeJson(store, s)))
  })

  get("/api/clusters/([^/]+)/nodes/([^/]+)", ([cluster, id], _u, res) => {
    const node = store.getNode(id)
    if (!node || node.cluster_id !== cluster) return notFound(res)
    json(res, 200, nodeJson(store, node))
  })

  // Latest value per sensor, joined with sensor metadata (the "console" of a node).
  get("/api/clusters/([^/]+)/nodes/([^/]+)/latest", ([cluster, id], _u, res) => {
    const node = store.getNode(id)
    if (!node || node.cluster_id !== cluster) return notFound(res)
    const latest = new Map(store.latestValues(id).map((r) => [r.sensor, r]))
    json(
      res,
      200,
      node.sensors.flatMap((sensor) => {
        const row = latest.get(sensor.id)
        return row ? [{ ...sensor, value: row.value, ts: row.ts }] : []
      })
    )
  })

  // The agent token of the cluster: shown to signed-in users. Nodes name themselves and
  // join the cluster with it.
  get("/api/clusters/([^/]+)/token", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    json(res, 200, { token: store.getClusterToken(cluster) })
  })

  // Issues a new token; every agent of the cluster has to be restarted with it.
  post("/api/clusters/([^/]+)/token", ([cluster], _u, res, _b, { user }) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const token = randomBytes(24).toString("hex")
    store.setClusterToken(cluster, token)
    console.log(`agent token of cluster ${cluster} regenerated by "${user}"`)
    json(res, 200, { token })
  })

  get("/api/clusters/([^/]+)/nodes/([^/]+)/loadavg", ([cluster, id], url, res) => {
    const node = store.getNode(id)
    if (!node || node.cluster_id !== cluster) return notFound(res)
    const bucket = positive(url.searchParams.get("bucket"), 60_000)
    const since = positive(url.searchParams.get("since"), Date.now() - 3_600_000)
    const rows = store.bucketedSamples([id], since, Date.now(), bucket)
    const keys: Record<string, string> = {
      "system/load1": "load1",
      "system/load5": "load5",
      "system/load15": "load15",
    }
    const points = new Map<number, Point>()
    for (const row of rows) {
      const key = keys[row.sensor]
      if (!key) continue
      const p = points.get(row.bucket) ?? { t: row.bucket, time: hhmm(row.bucket) }
      p[key] = +row.value.toFixed(2)
      points.set(row.bucket, p)
    }
    json(res, 200, [...points.values()].sort((a, b) => a.t - b.t))
  })

  // Everything the overview page shows, in one small response: the most recent nodes
  // (online first), the tests that run or wait, and the latest finished tests.
  // ?nodes=<n>&history=<n> change the sizes (1..50).
  get("/api/clusters/([^/]+)/overview", ([cluster], url, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const size = (name: string, fallback: number) =>
      Math.min(Math.max(Math.floor(Number(url.searchParams.get(name))) || fallback, 1), 50)

    const nodes = store
      .listNodes(cluster)
      .map((s) => nodeJson(store, s))
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          (b.lastSeen ?? 0) - (a.lastSeen ?? 0) ||
          a.name.localeCompare(b.name)
      )
    const activeStatuses = ["running", "queued"] as const
    const finishedStatuses = ["passed", "failed", "aborted"] as const
    json(res, 200, {
      nodes: {
        total: nodes.length,
        online: nodes.filter((s) => s.online).length,
        items: nodes.slice(0, size("nodes", 5)),
      },
      active: {
        total: store.countTests(cluster, [...activeStatuses]),
        items: store.listClusterTests(cluster, [...activeStatuses], 20, "active").map(testJson),
      },
      history: {
        total: store.countTests(cluster, [...finishedStatuses]),
        items: store
          .listClusterTests(cluster, [...finishedStatuses], size("history", 8), "recent")
          .map(testJson),
      },
    })
  })

  get("/api/clusters/([^/]+)/tests", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    json(res, 200, store.listTests(cluster).map(testJson))
  })

  get("/api/clusters/([^/]+)/tests/([^/]+)", ([cluster, id], _u, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    json(res, 200, testJson(test))
  })

  get("/api/clusters/([^/]+)/tests/([^/]+)/telemetry", ([cluster, id], url, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    const bucket = positive(url.searchParams.get("bucket"), 60_000)
    json(res, 200, testTelemetry(store, test, bucket))
  })

  // min / avg / max of every sensor over the test
  get("/api/clusters/([^/]+)/tests/([^/]+)/stats", ([cluster, id], _u, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    json(res, 200, testStats(store, test))
  })

  // The state of every node of the test: waiting, running, passed, failed, stopped, lost.
  get("/api/clusters/([^/]+)/tests/([^/]+)/nodes", ([cluster, id], _u, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    json(res, 200, store.testNodes(test))
  })

  // The sensor readings of a test. ?format=csv (default): a zip named after the test with
  // one CSV (the format of the powerlog tool) per node; ?format=json: one JSON for all the
  // nodes. ?nodes=a,b limits the export to the named nodes of the test.
  get("/api/clusters/([^/]+)/tests/([^/]+)/export", ([cluster, id], url, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)

    const all = test.nodeIds.map((nodeId) => ({
      id: nodeId,
      name: store.getNode(nodeId)?.name ?? nodeId,
    }))
    const wanted = url.searchParams.get("nodes")
    const chosen = wanted ? wanted.split(",").filter(Boolean) : all.map((n) => n.name)
    const nodes = chosen.map((name) => all.find((n) => n.name === name))
    const unknown = chosen.filter((_, i) => !nodes[i])
    if (unknown.length) throw new HttpError(400, `not nodes of this test: ${unknown.slice(0, 5).join(", ")}`)
    if (!nodes.length) throw new HttpError(400, "no nodes selected")
    const picked = nodes as { id: string; name: string }[]

    // the file name: what the user called the test, without characters a file name cannot hold
    const base = test.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100) || test.id
    const send = (type: string, ext: string, body: string | Buffer) => {
      const ascii = (base.replace(/[^\x20-\x7e]/g, "_") || test.id) + ext
      res.writeHead(200, {
        "content-type": type,
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base + ext)}`,
      })
      res.end(body)
    }
    if (url.searchParams.get("format") === "json")
      return send(
        "application/json; charset=utf-8",
        ".json",
        JSON.stringify(testExportJson(store, test, testJson(test), picked.map((n) => n.id)))
      )
    if (url.searchParams.get("format") && url.searchParams.get("format") !== "csv")
      throw new HttpError(400, "format is csv or json")
    send(
      "application/zip",
      ".zip",
      zip(picked.map((n) => ({ name: `${n.name}.csv`, data: Buffer.from(testCsv(store, test, n.id)) })))
    )
  })

  get("/api/clusters/([^/]+)/tests/([^/]+)/log", ([cluster, id], _u, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    json(res, 200, store.testLog(id))
  })

  // Live stream of one test (Server-Sent Events):
  //   log     {id, ts, line, nodeId}   a new log line (nodeId: the node it belongs to)
  //   node    {nodeId, name, status, error, startedAt, finishedAt}   a node started or finished (id is the SSE event id, usable for resuming)
  //   status  {status, durationMs, result}   sent on connect and whenever it changes
  //   point   {t, values: {kind: {nodeId: value}}}   latest sensor values, at most 1/s
  // `?after=<log id>` or the Last-Event-ID header resumes behind lines already seen.
  get("/api/clusters/([^/]+)/tests/([^/]+)/events", ([cluster, id], url, res, _body, { req }) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // tell nginx not to buffer
    })
    // resolves when the stream ends (client left or the test finished)
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
    let done = false
    function finish() {
      if (done) return
      done = true
      clearInterval(flush)
      clearInterval(heartbeat)
      bus.off("log", onLog)
      bus.off("status", onStatus)
      bus.off("node", onNode)
      bus.off("sample", onSample)
      res.end()
      resolveClosed()
    }
    const send = (event: string, data: unknown, eventId?: number) =>
      res.write(`${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    const header = Number(req.headers["last-event-id"])
    let lastLog = header > 0 ? header : Number(url.searchParams.get("after")) || 0
    const onLog = (testId: string, entry: LogEntry) => {
      if (testId !== id || entry.id <= lastLog) return
      lastLog = entry.id
      send("log", entry, entry.id)
    }
    const sendStatus = () => {
      const t = store.getTest(cluster, id)
      if (!t) return
      const body = {
        status: t.status,
        durationMs: t.finishedAt ? t.finishedAt - t.startedAt : null,
        result: t.result,
      }
      send("status", body)
      if (t.status !== "running" && t.status !== "queued") finish()
    }
    const onStatus = (testId: string) => testId === id && sendStatus()
    const onNode = (testId: string, node: NodeRun) => testId === id && send("node", node)

    // the latest value of every sensor of the test's nodes; `meta` describes sensors the
    // client has not heard of yet (they can appear while the test runs)
    const refs = sensorRefs(store, test.nodeIds)
    const announced = new Set<string>()
    let pending: Record<string, number> = {}
    let pendingAt = 0
    const onSample = (nodeId: string, ts: number, values: Record<string, number>) => {
      if (!test.nodeIds.includes(nodeId)) return
      for (const [sensorId, value] of Object.entries(values)) {
        pending[sensorKey(nodeId, sensorId)] = value
        pendingAt = ts
      }
    }
    const token = bearer(req)
    const flush = setInterval(() => {
      // logging out or an expired session ends the stream
      if (!store.sessionUser(token)) return finish()
      if (!pendingAt) return
      const meta: Record<string, unknown> = {}
      for (const key of Object.keys(pending)) {
        if (announced.has(key)) continue
        announced.add(key)
        const ref = refs.get(key)
        const [nodeId, ...rest] = key.split("|")
        meta[key] = ref ?? { key, nodeId, node: store.getNode(nodeId)?.name ?? nodeId, id: rest.join("|"), label: rest.join("|"), kind: "other", unit: "" }
      }
      send("point", { t: pendingAt, values: pending, ...(Object.keys(meta).length ? { meta } : {}) })
      pending = {}
      pendingAt = 0
    }, 1000)
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000)

    // subscribe first, then replay, so no line is lost in between
    bus.on("log", onLog)
    bus.on("status", onStatus)
    bus.on("node", onNode)
    bus.on("sample", onSample)
    req.on("close", finish)
    for (const entry of store.testLog(id, 5000, lastLog)) onLog(id, entry)
    sendStatus()
    return closed
  })

  // Raw samples: ?sensor=&since=<unix ms>&limit=<=5000
  get("/api/nodes/([^/]+)/samples", ([id], url, res) => {
    const rows = store.nodeSamples(id, {
      sensor: url.searchParams.get("sensor") ?? undefined,
      since: Number(url.searchParams.get("since") ?? 0) || 0,
      limit: Math.min(positive(url.searchParams.get("limit"), 1000), 5000),
    })
    json(res, 200, rows.reverse())
  })

  // --- the files of the scripts directory (file manager and editor) ---
  // Every change copies the directory to the nodes that are online.

  const scriptPath = (url: URL) => url.searchParams.get("path") ?? ""

  get("/api/clusters/([^/]+)/scripts/file", ([cluster], url, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const path = scriptPath(url)
    json(res, 200, { path, ...readText(cluster, path) })
  })

  // ?base=<sha256 the editor started from> or "new"; ?exec=true|false for the executable bit
  put(
    "/api/clusters/([^/]+)/scripts/file",
    ([cluster], url, res, body) => {
      if (!store.clusterExists(cluster)) return notFound(res)
      const path = scriptPath(url)
      const exec = url.searchParams.get("exec")
      const saved = writeFileChecked(
        cluster,
        path,
        body as Buffer,
        url.searchParams.get("base") ?? "new",
        exec === null ? undefined : exec === "true"
      )
      syncCluster(store, cluster)
      json(res, 200, { path, ...saved })
    },
    true
  )

  // a file, or a folder with everything in it
  del("/api/clusters/([^/]+)/scripts/file", ([cluster], url, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    deleteEntry(cluster, scriptPath(url))
    syncCluster(store, cluster)
    json(res, 200, { ok: true })
  })

  post("/api/clusters/([^/]+)/scripts/rename", ([cluster], _u, res, body) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const { from, to } = (body ?? {}) as { from?: unknown; to?: unknown }
    if (typeof from !== "string" || typeof to !== "string") throw new HttpError(400, "from and to are required")
    renameEntry(cluster, from, to)
    syncCluster(store, cluster)
    json(res, 200, { ok: true })
  })

  // Copies the scripts directory to the nodes of the cluster that are online (the sync
  // button, e.g. after an error was fixed). Progress shows in the sync state of the nodes.
  post("/api/clusters/([^/]+)/sync", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const nodes = store.listNodes(cluster).filter((s) => isNodeOnline(s.id)).length
    syncCluster(store, cluster)
    json(res, 202, { nodes })
  })

  // Files of the scripts directory of the cluster (the test form offers the .sh files).
  get("/api/clusters/([^/]+)/scripts", ([cluster], _u, res) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const manifest = buildManifest(cluster)
    json(res, 200, {
      version: manifest.version,
      files: manifest.files.map((f) => ({ path: f.path, size: f.size })),
    })
  })

  // --- authentication: PAM login, bearer-token sessions ---

  post("/api/auth/login", async (_m, _u, res, body, { req }) => {
    const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown }
    const ip = forwardedAddress(req)
    // Per user always; per address only when it is known, otherwise every user would
    // share the address of the web UI server and one attacker could lock everyone out.
    const userKey = `user:${String(username).toLowerCase()}`
    const keys = ip ? [userKey, `ip:${ip}`] : [userKey]
    const wait = Math.max(...keys.map((k) => throttle.blockedFor(k)))
    if (wait > 0) {
      res.setHeader("retry-after", String(Math.ceil(wait / 1000)))
      return json(res, 429, { error: "too many attempts, try again later" })
    }

    const result =
      validUsername(username) && typeof password === "string"
        ? await pamCheck(username, password)
        : "rejected"
    if (result === "error") {
      console.error("login unavailable: the PAM helper failed (check pam/xcale-pam and /etc/pam.d)")
      return json(res, 503, { error: "login is temporarily unavailable" })
    }
    if (result === "rejected") {
      keys.forEach((k) => throttle.fail(k))
      console.log(`login failed for "${String(username).slice(0, 64).replace(/[^\x20-\x7e]/g, "?")}" from ${ip || "-"}`)
      await new Promise((r) => setTimeout(r, 400)) // slows down guessing
      return json(res, 401, { error: "invalid username or password" })
    }

    throttle.reset(userKey)
    const token = newSessionToken()
    const expiresAt = Date.now() + authConfig.sessionMs
    store.createSession(token, username as string, expiresAt)
    console.log(`login ok for "${username}" from ${ip || "-"}`)
    json(res, 200, { token, username, expiresAt })
  })

  get("/api/auth/me", (_m, _u, res, _body, { user }) =>
    json(res, 200, { username: user })
  )

  post("/api/auth/logout", (_m, _u, res, _body, { req }) => {
    store.deleteSession(bearer(req))
    json(res, 200, { ok: true })
  })

  post("/api/clusters/([^/]+)/tests", ([cluster], _u, res, body, { user }) => {
    if (!store.clusterExists(cluster)) return notFound(res)
    const test = runner.create(cluster, parseNewTest(store, cluster, body, user))
    json(res, 201, testJson(test))
  })

  post("/api/clusters/([^/]+)/tests/([^/]+)/stop", ([cluster, id], _u, res) => {
    if (!store.getTest(cluster, id)) return notFound(res)
    const outcome = runner.stop(id)
    if (outcome === "finished") return json(res, 409, { error: "test already finished" })
    json(res, 200, { status: outcome })
  })

  post("/api/clusters/([^/]+)/tests/([^/]+)/rerun", ([cluster, id], _u, res, _body, { user }) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    json(res, 201, testJson(runner.rerun(test, user)))
  })

  del("/api/clusters/([^/]+)/tests/([^/]+)", ([cluster, id], _u, res) => {
    const test = store.getTest(cluster, id)
    if (!test) return notFound(res)
    if (test.status === "running" || test.status === "queued")
      return json(res, 409, { error: "stop the test first" })
    store.deleteTest(id)
    json(res, 200, { ok: true })
  })

  return createServer(async (req, res) => {
    const method = req.method ?? "GET"
    const url = new URL(req.url ?? "/", "http://localhost")
    const candidates = routes.filter(([, pattern]) => pattern.test(url.pathname))
    // a different message than for a missing resource: the web UI tells an outdated
    // server (older than the web UI) from "this cluster, server or test does not exist"
    if (!candidates.length) return json(res, 404, { error: "unknown route" })
    const match = candidates.find(([m]) => m === method)
    if (!match) return json(res, 405, { error: "method not allowed" })

    try {
      let user = ""
      if (!publicRoutes.has(`${method} ${url.pathname}`)) {
        user = store.sessionUser(bearer(req)) ?? ""
        if (!user) return json(res, 401, { error: "not signed in" })
      }
      const [, pattern, handler, raw] = match
      let body: unknown
      if (method !== "GET") {
        const origin = req.headers.origin
        if (origin && !allowedOrigins.includes(origin))
          throw new HttpError(403, "cross-origin request refused")
        body = raw ? await readRaw(req, limits.file) : await readBody(req)
      }
      const groups = pattern.exec(url.pathname)!.slice(1).map(decodeURIComponent)
      await handler(groups, url, res, body, { req, user })
    } catch (error) {
      if (error instanceof HttpError || error instanceof ScriptsError)
        return json(res, error.status, { error: error.message })
      console.error("request failed:", error)
      json(res, 500, { error: "internal error" })
    }
  })
}
