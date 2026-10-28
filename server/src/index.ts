import { attachAgentServer } from "./agents.ts"
import { Store } from "./db.ts"
import { createHttpServer } from "./http.ts"
import { Runner } from "./runner.ts"
import { ensureClusterDir, scriptsRoot } from "./scripts.ts"

const port = Number(process.env.PORT ?? 4000)
// Loopback by default: the REST API has no auth yet. Set HOST=0.0.0.0 so lab agents can connect.
const host = process.env.HOST ?? "127.0.0.1"
const dbPath = process.env.DB_PATH ?? "data/xcale.db"

const store = new Store(dbPath)
// every cluster has its scripts directory (new ones get the examples)
for (const cluster of store.listClusters()) ensureClusterDir(cluster.id)
const runner = new Runner(store)
const http = createHttpServer(store, runner)
attachAgentServer(http, store)
runner.recover()

http.listen(port, host, () => {
  console.log(
    `xcale server on http://${host}:${port} (agents: ws://${host}:${port}/agent), db ${dbPath}, scripts ${scriptsRoot}`
  )
})

function shutdown() {
  http.close()
  store.db.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
