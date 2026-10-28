import { randomBytes } from "node:crypto"

import { Store } from "./db.ts"
import { nameProblem } from "./names.ts"

// node src/nodes.ts <cluster> [--regenerate]
//   Prints the agent token of the cluster (the cluster is created if needed).
//   --regenerate issues a new token, the old one stops working.
// Nodes need no registration: an agent names itself and joins with the token.
const [cluster, flag] = process.argv.slice(2)
const problem = cluster ? nameProblem(cluster) : "usage: node src/nodes.ts <cluster> [--regenerate]"
if (problem) {
  console.error(problem)
  process.exit(2)
}

const store = new Store(process.env.DB_PATH ?? "data/xcale.db")
store.upsertCluster(cluster, cluster)
if (flag === "--regenerate") store.setClusterToken(cluster, randomBytes(24).toString("hex"))
console.log(`${cluster}\t${store.getClusterToken(cluster)}`)
store.db.close()
