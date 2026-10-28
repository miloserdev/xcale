import { Store } from "./db.ts"
import { seedDemo } from "./seed-demo.ts"

// Creates clusters and nodes that do not exist yet and prints the agent token of each cluster.
// `--demo` also (re)creates demo tests with synthetic sensor history.
const store = new Store(process.env.DB_PATH ?? "data/xcale.db")

const clusters: Record<string, string[]> = {
  thermal_stand_0: ["node-01", "node-02", "node-03"],
  thermal_stand_1: ["node-01", "node-02"],
  gpu_cluster_a: ["gpu-a-01", "gpu-a-02", "gpu-a-03", "gpu-a-04"],
  dev: ["local"],
}

for (const [clusterId, names] of Object.entries(clusters)) {
  store.upsertCluster(clusterId, clusterId)
  for (const name of names) {
    const id = `${clusterId}.${name}`
    store.createNode({ id, clusterId, name })
  }
  console.log(`${clusterId}\t${store.getClusterToken(clusterId)}`)
}
if (process.argv.includes("--demo")) {
  seedDemo(store)
  console.log("demo tests and sensor history created")
}
console.log("seed done")
store.db.close()
