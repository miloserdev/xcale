import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { bus, type LogEntry, type NodeRun } from "./bus.ts"
import { assertName } from "./names.ts"
import type { MachineInfo, SensorInfo, SensorKind } from "./protocol.ts"

const schema = `
CREATE TABLE IF NOT EXISTS clusters (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL DEFAULT '',
  token      TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  cluster_id      TEXT NOT NULL REFERENCES clusters(id),
  name          TEXT NOT NULL,
  last_seen     INTEGER,
  agent_version TEXT,
  sensors_json  TEXT NOT NULL DEFAULT '[]'
);
-- one row per test and node: how far the output of the agent was received
CREATE TABLE IF NOT EXISTS test_runs (
  test_id   TEXT    NOT NULL REFERENCES tests(id),
  node_id TEXT    NOT NULL,
  last_seq  INTEGER NOT NULL DEFAULT 0,
  status    TEXT    NOT NULL DEFAULT 'running', -- running, passed, failed, stopped, lost
  error     TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (test_id, node_id)
);
CREATE TABLE IF NOT EXISTS samples (
  node_id TEXT    NOT NULL REFERENCES nodes(id),
  ts        INTEGER NOT NULL, -- unix ms
  sensor    TEXT    NOT NULL,
  value     REAL    NOT NULL
);
CREATE TABLE IF NOT EXISTS tests (
  id            TEXT PRIMARY KEY,
  cluster_id      TEXT NOT NULL REFERENCES clusters(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL,
  scripts_json  TEXT NOT NULL DEFAULT '[]',
  nodes_json  TEXT NOT NULL DEFAULT '[]',
  configs_json  TEXT NOT NULL DEFAULT '{}',
  metrics_json  TEXT NOT NULL DEFAULT '[]',
  started_at    INTEGER NOT NULL, -- unix ms
  finished_at   INTEGER,
  started_by    TEXT NOT NULL,
  result_json   TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tests_cluster_started ON tests (cluster_id, started_at DESC);
CREATE TABLE IF NOT EXISTS test_log (
  test_id TEXT    NOT NULL REFERENCES tests(id),
  ts      INTEGER NOT NULL,
  line    TEXT    NOT NULL,
  node_id TEXT
);
CREATE INDEX IF NOT EXISTS test_log_test_ts ON test_log (test_id, ts);
CREATE INDEX IF NOT EXISTS samples_node_ts ON samples (node_id, ts);
CREATE INDEX IF NOT EXISTS samples_node_sensor_ts ON samples (node_id, sensor, ts);
`

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export type NodeRow = {
  id: string
  cluster_id: string
  name: string
  last_seen: number | null
  agent_version: string | null
  last_ip: string | null // as seen by the server on the last connection
  last_mac: string | null // reported by the agent
  group_name: string | null // the group of the node inside its cluster
  sync_status: SyncStatus
  sync_version: string | null
  sync_error: string | null
  sync_at: number | null
  info: MachineInfo
  sensors: SensorInfo[]
}

// Whether the scripts directory of the node matches the one of the cluster.
export type SyncStatus = "unknown" | "syncing" | "synced" | "outdated" | "failed"

type RawNode = Omit<NodeRow, "sensors" | "info"> & {
  sensors_json: string
  info_json: string
}

export type TestStatus = "queued" | "running" | "passed" | "failed" | "aborted"

// null when the test collected no data of that kind
// The peaks over all sensors of the nodes; the full picture is the per-sensor statistics.
export type TestResult = {
  maxTemp: number | null // hottest temperature sensor, °C
  maxPower: number | null // highest reading of a single power sensor, W
}

export type SensorStat = {
  nodeId: string
  sensor: string
  min: number
  avg: number
  max: number
  samples: number
}

export type TestRow = {
  id: string
  clusterId: string
  name: string
  status: TestStatus
  scriptsPaths: string[]
  nodeIds: string[]
  configs: Record<string, string>
  metrics: SensorKind[]
  startedAt: number
  finishedAt: number | null
  startedBy: string
  result: TestResult | null
}

type RawTest = {
  id: string
  cluster_id: string
  name: string
  status: TestStatus
  scripts_json: string
  nodes_json: string
  configs_json: string
  metrics_json: string
  started_at: number
  finished_at: number | null
  started_by: string
  result_json: string | null
}

function toTest(r: RawTest): TestRow {
  return {
    id: r.id,
    clusterId: r.cluster_id,
    name: r.name,
    status: r.status,
    scriptsPaths: JSON.parse(r.scripts_json),
    nodeIds: JSON.parse(r.nodes_json),
    configs: JSON.parse(r.configs_json),
    metrics: JSON.parse(r.metrics_json),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    startedBy: r.started_by,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  }
}

export class Store {
  db: DatabaseSync

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    this.renameSpacesToClusters()
    this.renameServersToNodes()
    this.db.exec(schema)
    this.migrate()
  }

  // Databases created when clusters were still called spaces.
  private renameSpacesToClusters() {
    const hasTable = (name: string) =>
      !!this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name)
    if (hasTable("spaces") && !hasTable("clusters")) {
      this.db.exec("ALTER TABLE spaces RENAME TO clusters")
    }
    for (const table of ["servers", "nodes", "tests"]) {
      if (!hasTable(table)) continue
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string
      }[]
      if (columns.some((c) => c.name === "space_id")) {
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN space_id TO cluster_id`)
      }
    }
    this.db.exec("DROP INDEX IF EXISTS tests_space_started")
  }

  // Databases created when nodes were still called servers.
  private renameServersToNodes() {
    const hasTable = (name: string) =>
      !!this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name)
    const rename = (table: string, from: string, to: string) => {
      if (!hasTable(table)) return
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (columns.some((c) => c.name === from)) this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
    }
    if (hasTable("servers") && !hasTable("nodes")) this.db.exec("ALTER TABLE servers RENAME TO nodes")
    for (const table of ["samples", "test_runs", "test_log"]) rename(table, "server_id", "node_id")
    rename("tests", "servers_json", "nodes_json")
    this.db.exec("DROP INDEX IF EXISTS samples_server_ts; DROP INDEX IF EXISTS samples_server_sensor_ts")
  }

  // Columns added after the first release of the schema.
  private migrate() {
    const cols = this.db.prepare("PRAGMA table_info(nodes)").all() as {
      name: string
    }[]
    if (!cols.some((c) => c.name === "info_json")) {
      this.db.exec(
        "ALTER TABLE nodes ADD COLUMN info_json TEXT NOT NULL DEFAULT '{}'"
      )
    }
    const add = (name: string, definition: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.exec(`ALTER TABLE nodes ADD COLUMN ${name} ${definition}`)
    }
    add("last_ip", "TEXT")
    add("last_mac", "TEXT")
    add("group_name", "TEXT")
    add("sync_status", "TEXT NOT NULL DEFAULT 'unknown'")
    add("sync_version", "TEXT")
    add("sync_error", "TEXT")
    add("sync_at", "INTEGER")
    // Agents connect to the server, so nodes have no address or SSH settings any more.
    // which node a log line and a run belong to, when a run started and ended
    const columnsOf = (table: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    const addTo = (table: string, name: string, definition: string) => {
      if (!columnsOf(table).includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
    addTo("test_log", "node_id", "TEXT")
    addTo("test_runs", "started_at", "INTEGER")
    addTo("test_runs", "finished_at", "INTEGER")
    const clusterCols = this.db.prepare("PRAGMA table_info(clusters)").all() as { name: string }[]
    if (!clusterCols.some((c) => c.name === "token_hash"))
      this.db.exec("ALTER TABLE clusters ADD COLUMN token_hash TEXT NOT NULL DEFAULT ''")
    if (!clusterCols.some((c) => c.name === "token"))
      this.db.exec("ALTER TABLE clusters ADD COLUMN token TEXT")
    for (const { id } of this.db.prepare("SELECT id FROM clusters WHERE token IS NULL").all() as { id: string }[])
      this.setClusterToken(id, randomBytes(24).toString("hex"))
    // One token per cluster instead of one per node: nodes register themselves.
    for (const old of ["host", "ssh_user", "ssh_port", "token", "token_hash"]) {
      if (cols.some((c) => c.name === old))
        this.db.exec(`ALTER TABLE nodes DROP COLUMN ${old}`)
    }
  }

  // Creates the cluster with a new agent token when it does not exist yet.
  upsertCluster(id: string, name: string) {
    assertName(id, "cluster")
    const token = randomBytes(24).toString("hex")
    this.db
      .prepare("INSERT OR IGNORE INTO clusters (id, name, token_hash, token) VALUES (?, ?, ?, ?)")
      .run(id, name, hashToken(token), token)
  }

  // Registers a node; false when it is already known (a node stays in the cluster while it
  // is offline).
  createNode(s: { id: string; clusterId: string; name: string }) {
    assertName(s.name, "node")
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO nodes (id, cluster_id, name) VALUES (?, ?, ?)")
        .run(s.id, s.clusterId, s.name).changes > 0
    )
  }

  // --- state of the node that the agent reports (see agents.ts) ---

  setSyncState(
    nodeId: string,
    status: SyncStatus,
    opts: { version?: string | null; error?: string | null } = {}
  ) {
    this.db
      .prepare(
        "UPDATE nodes SET sync_status = ?, sync_version = COALESCE(?, sync_version), sync_error = ?, sync_at = ? WHERE id = ?"
      )
      .run(status, opts.version ?? null, opts.error ?? null, Date.now(), nodeId)
  }

  // After a script change nodes that were in sync are behind until they sync again.
  markClusterOutdated(clusterId: string) {
    this.db
      .prepare(
        "UPDATE nodes SET sync_status = 'outdated' WHERE cluster_id = ? AND sync_status = 'synced'"
      )
      .run(clusterId)
  }

  // --- progress of a test on one node (resuming the output after a lost connection) ---

  startRun(testId: string, nodeId: string) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO test_runs (test_id, node_id, last_seq, status, error, started_at) VALUES (?, ?, 0, 'running', NULL, ?)"
      )
      .run(testId, nodeId, Date.now())
    this.emitNode(testId, nodeId)
  }

  // The state of every node of a test; nodes that have not started yet are "waiting".
  testNodes(test: { id: string; nodeIds: string[] }): NodeRun[] {
    const rows = this.db
      .prepare("SELECT node_id, status, error, started_at, finished_at FROM test_runs WHERE test_id = ?")
      .all(test.id) as {
        node_id: string
        status: string
        error: string | null
        started_at: number | null
        finished_at: number | null
      }[]
    const byNode = new Map(rows.map((r) => [r.node_id, r]))
    return test.nodeIds.map((nodeId) => {
      const r = byNode.get(nodeId)
      return {
        nodeId,
        name: this.getNode(nodeId)?.name ?? nodeId,
        status: r?.status ?? "waiting",
        error: r?.error ?? null,
        startedAt: r?.started_at ?? null,
        finishedAt: r?.finished_at ?? null,
      }
    })
  }

  private emitNode(testId: string, nodeId: string) {
    const run = this.testNodes({ id: testId, nodeIds: [nodeId] })[0]
    bus.emit("node", testId, run)
  }

  runSeq(testId: string, nodeId: string) {
    const row = this.db
      .prepare("SELECT last_seq FROM test_runs WHERE test_id = ? AND node_id = ?")
      .get(testId, nodeId) as { last_seq: number } | undefined
    return row ? row.last_seq : null
  }

  advanceRun(testId: string, nodeId: string, seq: number) {
    this.db
      .prepare("UPDATE test_runs SET last_seq = ? WHERE test_id = ? AND node_id = ?")
      .run(seq, testId, nodeId)
  }

  finishRun(testId: string, nodeId: string, status: string, error?: string) {
    const now = Date.now()
    // a node that failed before it started (no agent, sync error) has no row yet
    this.db
      .prepare(
        `INSERT INTO test_runs (test_id, node_id, last_seq, status, error, started_at, finished_at)
         VALUES (?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (test_id, node_id) DO UPDATE SET status = excluded.status, error = excluded.error, finished_at = excluded.finished_at`
      )
      .run(testId, nodeId, status, error ?? null, now, now)
    this.emitNode(testId, nodeId)
  }

  // Replaces the agent token of the cluster (all agents have to be restarted with it);
  // false when the cluster is unknown.
  setClusterToken(clusterId: string, token: string) {
    return (
      this.db
        .prepare("UPDATE clusters SET token_hash = ?, token = ? WHERE id = ?")
        .run(hashToken(token), token, clusterId).changes > 0
    )
  }

  getClusterToken(clusterId: string) {
    const row = this.db
      .prepare("SELECT token FROM clusters WHERE id = ?")
      .get(clusterId) as { token: string | null } | undefined
    return row?.token ?? null
  }

  // Constant-time token check of a cluster.
  checkClusterToken(clusterId: string, token: string) {
    const row = this.db
      .prepare("SELECT token_hash FROM clusters WHERE id = ?")
      .get(clusterId) as { token_hash: string } | undefined
    const given = Buffer.from(hashToken(token), "hex")
    const expected = Buffer.from(row?.token_hash || hashToken(""), "hex")
    return !!row && !!row.token_hash && timingSafeEqual(given, expected)
  }

  markSeen(
    nodeId: string,
    version: string,
    info: MachineInfo,
    sensors: SensorInfo[],
    ip: string | null,
    mac: string | null
  ) {
    this.db
      .prepare(
        "UPDATE nodes SET last_seen = ?, agent_version = ?, info_json = ?, sensors_json = ?, last_ip = COALESCE(?, last_ip), last_mac = COALESCE(?, last_mac) WHERE id = ?"
      )
      .run(
        Date.now(),
        version,
        JSON.stringify(info),
        JSON.stringify(sensors),
        ip,
        mac,
        nodeId
      )
  }

  // Used by seed to describe demo nodes that have no real agent.
  setNodeDetails(
    nodeId: string,
    info: MachineInfo,
    sensors: SensorInfo[]
  ) {
    this.db
      .prepare("UPDATE nodes SET info_json = ?, sensors_json = ? WHERE id = ?")
      .run(JSON.stringify(info), JSON.stringify(sensors), nodeId)
  }

  getNode(nodeId: string) {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(nodeId) as RawNode | undefined
    return row ? toNode(row) : null
  }

  // Puts the nodes of the cluster into a group; null takes them out of their group.
  setNodesGroup(clusterId: string, ids: string[], group: string | null) {
    const update = this.db.prepare("UPDATE nodes SET group_name = ? WHERE id = ? AND cluster_id = ?")
    let changed = 0
    for (const id of ids) changed += Number(update.run(group, id, clusterId).changes)
    return changed
  }

  // Latest value of every sensor of a node.
  latestValues(nodeId: string) {
    return this.db
      .prepare(
        `SELECT s.sensor, s.value, s.ts FROM samples s
         JOIN (SELECT sensor, MAX(ts) AS ts FROM samples WHERE node_id = ? GROUP BY sensor) m
           ON m.sensor = s.sensor AND m.ts = s.ts
         WHERE s.node_id = ?`
      )
      .all(nodeId, nodeId) as { sensor: string; value: number; ts: number }[]
  }

  // Average of each sensor per time bucket; `ids` are node ids.
  bucketedSamples(ids: string[], from: number, to: number, bucketMs: number) {
    if (!ids.length) return []
    const marks = ids.map(() => "?").join(",")
    return this.db
      .prepare(
        `SELECT node_id, sensor, (ts / ?) * ? AS bucket, AVG(value) AS value
         FROM samples
         WHERE node_id IN (${marks}) AND ts BETWEEN ? AND ?
         GROUP BY node_id, sensor, bucket ORDER BY bucket`
      )
      .all(bucketMs, bucketMs, ...ids, from, to) as {
      node_id: string
      sensor: string
      bucket: number
      value: number
    }[]
  }

  createTest(t: TestRow, log: { ts: number; line: string }[] = []) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tests
         (id, cluster_id, name, status, scripts_json, nodes_json, configs_json, metrics_json,
          started_at, finished_at, started_by, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.id,
        t.clusterId,
        t.name,
        t.status,
        JSON.stringify(t.scriptsPaths),
        JSON.stringify(t.nodeIds),
        JSON.stringify(t.configs),
        JSON.stringify(t.metrics),
        t.startedAt,
        t.finishedAt,
        t.startedBy,
        t.result ? JSON.stringify(t.result) : null
      )
    this.db.prepare("DELETE FROM test_log WHERE test_id = ?").run(t.id)
    const insert = this.db.prepare(
      "INSERT INTO test_log (test_id, ts, line) VALUES (?, ?, ?)"
    )
    for (const l of log) insert.run(t.id, l.ts, l.line)
  }

  listTests(clusterId: string) {
    return (
      this.db
        .prepare("SELECT * FROM tests WHERE cluster_id = ? ORDER BY started_at DESC")
        .all(clusterId) as RawTest[]
    ).map(toTest)
  }

  countTests(clusterId: string, statuses: TestStatus[]) {
    const marks = statuses.map(() => "?").join(",")
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM tests WHERE cluster_id = ? AND status IN (${marks})`
        )
        .get(clusterId, ...statuses) as { c: number }
    ).c
  }

  // Tests of a cluster with one of the statuses. "active": running first, then the queue
  // in start order; "recent": the most recently finished first.
  listClusterTests(
    clusterId: string,
    statuses: TestStatus[],
    limit: number,
    order: "active" | "recent"
  ) {
    const marks = statuses.map(() => "?").join(",")
    const orderBy =
      order === "active"
        ? "(status = 'running') DESC, started_at"
        : "COALESCE(finished_at, started_at) DESC"
    return (
      this.db
        .prepare(
          `SELECT * FROM tests WHERE cluster_id = ? AND status IN (${marks}) ORDER BY ${orderBy} LIMIT ?`
        )
        .all(clusterId, ...statuses, limit) as RawTest[]
    ).map(toTest)
  }

  getTest(clusterId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM tests WHERE cluster_id = ? AND id = ?")
      .get(clusterId, id) as RawTest | undefined
    return row ? toTest(row) : null
  }

  // --- web sessions (only the hash of the token is stored) ---

  createSession(token: string, username: string, expiresAt: number) {
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)"
      )
      .run(hashToken(token), username, Date.now(), expiresAt)
  }

  // The username of a valid, unexpired session, else null.
  sessionUser(token: string) {
    const row = this.db
      .prepare("SELECT username, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(token)) as { username: string; expires_at: number } | undefined
    return row && row.expires_at > Date.now() ? row.username : null
  }

  deleteSession(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token))
  }

  purgeSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now())
  }

  // --- test lifecycle (used by the runner) ---

  listTestsByStatus(status: TestStatus) {
    return (
      this.db
        .prepare("SELECT * FROM tests WHERE status = ? ORDER BY started_at")
        .all(status) as RawTest[]
    ).map(toTest)
  }

  getTestById(id: string) {
    const row = this.db.prepare("SELECT * FROM tests WHERE id = ?").get(id) as
      | RawTest
      | undefined
    return row ? toTest(row) : null
  }

  markRunning(id: string) {
    this.db
      .prepare("UPDATE tests SET status = 'running', started_at = ? WHERE id = ?")
      .run(Date.now(), id)
    bus.emit("status", id)
  }

  finishTest(id: string, status: TestStatus, result: TestResult | null) {
    this.db
      .prepare(
        "UPDATE tests SET status = ?, finished_at = ?, result_json = ? WHERE id = ?"
      )
      .run(status, Date.now(), result ? JSON.stringify(result) : null, id)
    bus.emit("status", id)
  }

  appendLog(testId: string, line: string, nodeId: string | null = null, ts = Date.now()) {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO test_log (test_id, ts, line, node_id) VALUES (?, ?, ?, ?)")
      .run(testId, ts, line, nodeId)
    bus.emit("log", testId, { id: Number(lastInsertRowid), ts, line, nodeId })
  }

  logCount(testId: string) {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM test_log WHERE test_id = ?")
        .get(testId) as { c: number }
    ).c
  }

  deleteTest(id: string) {
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM test_runs WHERE test_id = ?").run(id)
      this.db.prepare("DELETE FROM test_log WHERE test_id = ?").run(id)
      this.db.prepare("DELETE FROM tests WHERE id = ?").run(id)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  // Minimum, average and maximum of every sensor of the nodes in a time window.
  sensorStats(nodeIds: string[], from: number, to: number): SensorStat[] {
    if (!nodeIds.length) return []
    const marks = nodeIds.map(() => "?").join(",")
    return (
      this.db
        .prepare(
          `SELECT node_id AS nodeId, sensor, MIN(value) AS min, AVG(value) AS avg,
                  MAX(value) AS max, COUNT(*) AS samples
           FROM samples WHERE node_id IN (${marks}) AND ts BETWEEN ? AND ?
           GROUP BY node_id, sensor ORDER BY node_id, sensor`
        )
        .all(...nodeIds, from, to) as SensorStat[]
    )
  }

  // Raw readings of one node, oldest first (the CSV export).
  rawSamples(nodeId: string, from: number, to: number) {
    return this.db
      .prepare(
        "SELECT ts, sensor, value FROM samples WHERE node_id = ? AND ts BETWEEN ? AND ? ORDER BY ts"
      )
      .all(nodeId, from, to) as { ts: number; sensor: string; value: number }[]
  }

  // Peaks of a finished test, for the lists.
  computeResult(nodeIds: string[], from: number, to: number): TestResult {
    let maxTemp: number | null = null
    let maxPower: number | null = null
    const kinds = new Map<string, string>() // "<node>|<sensor>" -> kind
    for (const id of nodeIds)
      for (const sensor of this.getNode(id)?.sensors ?? []) kinds.set(`${id}|${sensor.id}`, sensor.kind)
    for (const stat of this.sensorStats(nodeIds, from, to)) {
      const kind = kinds.get(`${stat.nodeId}|${stat.sensor}`)
      if (kind === "temperature") maxTemp = Math.max(maxTemp ?? stat.max, stat.max)
      else if (kind === "power") maxPower = Math.max(maxPower ?? stat.max, stat.max)
    }
    const round = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10)
    return { maxTemp: round(maxTemp), maxPower: round(maxPower) }
  }

  // Log lines with their ids (ascending); `after` resumes behind a line already seen.
  testLog(testId: string, limit = 5000, after = 0) {
    return this.db
      .prepare(
        "SELECT id, ts, line, nodeId FROM (SELECT rowid AS id, ts, line, node_id AS nodeId FROM test_log WHERE test_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT ?) ORDER BY id"
      )
      .all(testId, after, limit) as LogEntry[]
  }

  touch(nodeId: string) {
    this.db
      .prepare("UPDATE nodes SET last_seen = ? WHERE id = ?")
      .run(Date.now(), nodeId)
  }

  insertSamples(nodeId: string, ts: number, values: Record<string, number>) {
    const insert = this.db.prepare(
      "INSERT INTO samples (node_id, ts, sensor, value) VALUES (?, ?, ?, ?)"
    )
    this.db.exec("BEGIN")
    try {
      for (const [sensor, value] of Object.entries(values)) {
        insert.run(nodeId, ts, sensor, value)
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  // What deleting a cluster would remove, for the confirmation dialog.
  clusterStats(clusterId: string) {
    const count = (sql: string) =>
      (this.db.prepare(sql).get(clusterId) as { c: number }).c
    return {
      nodes: count("SELECT COUNT(*) AS c FROM nodes WHERE cluster_id = ?"),
      tests: count("SELECT COUNT(*) AS c FROM tests WHERE cluster_id = ?"),
      activeTests: count(
        "SELECT COUNT(*) AS c FROM tests WHERE cluster_id = ? AND status IN ('running', 'queued')"
      ),
    }
  }

  // Removes the cluster with its nodes, tests, logs and sensor history.
  deleteCluster(clusterId: string) {
    const stats = this.clusterStats(clusterId)
    this.db.exec("BEGIN")
    try {
      const run = (sql: string) => this.db.prepare(sql).run(clusterId)
      run("DELETE FROM test_runs WHERE test_id IN (SELECT id FROM tests WHERE cluster_id = ?)")
      run("DELETE FROM test_log WHERE test_id IN (SELECT id FROM tests WHERE cluster_id = ?)")
      run("DELETE FROM tests WHERE cluster_id = ?")
      run("DELETE FROM samples WHERE node_id IN (SELECT id FROM nodes WHERE cluster_id = ?)")
      run("DELETE FROM nodes WHERE cluster_id = ?")
      run("DELETE FROM clusters WHERE id = ?")
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return stats
  }

  deleteNode(nodeId: string) {
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM samples WHERE node_id = ?").run(nodeId)
      this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  // Running or waiting tests that use the node.
  activeTestsOnNode(nodeId: string) {
    return (
      this.db
        .prepare(
          "SELECT nodes_json FROM tests WHERE status IN ('running', 'queued')"
        )
        .all() as { nodes_json: string }[]
    ).filter((row) => (JSON.parse(row.nodes_json) as string[]).includes(nodeId)).length
  }

  listClusters() {
    return this.db
      .prepare(
        `SELECT s.id, s.name, COUNT(v.id) AS node_count
         FROM clusters s LEFT JOIN nodes v ON v.cluster_id = s.id
         GROUP BY s.id ORDER BY s.id`
      )
      .all() as { id: string; name: string; node_count: number }[]
  }

  listNodes(clusterId: string) {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE cluster_id = ? ORDER BY name")
      .all(clusterId) as RawNode[]
    return rows.map(toNode)
  }

  clusterExists(clusterId: string) {
    return !!this.db.prepare("SELECT 1 FROM clusters WHERE id = ?").get(clusterId)
  }

  nodeSamples(
    nodeId: string,
    opts: { sensor?: string; since: number; limit: number }
  ) {
    const sql = `SELECT ts, sensor, value FROM samples
      WHERE node_id = ? AND ts >= ? ${opts.sensor ? "AND sensor = ?" : ""}
      ORDER BY ts DESC LIMIT ?`
    const args = opts.sensor
      ? [nodeId, opts.since, opts.sensor, opts.limit]
      : [nodeId, opts.since, opts.limit]
    return this.db.prepare(sql).all(...args) as {
      ts: number
      sensor: string
      value: number
    }[]
  }
}

function toNode(row: RawNode): NodeRow {
  const { sensors_json, info_json, ...rest } = row
  return {
    ...rest,
    info: JSON.parse(info_json) as MachineInfo,
    sensors: JSON.parse(sensors_json) as SensorInfo[],
  }
}
