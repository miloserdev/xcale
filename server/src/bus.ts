import { EventEmitter } from "node:events"

// In-process event bus feeding the SSE streams.
//   "log"    (testId, { id, ts, line })        a line was added to a test log
//   "node"   (testId, NodeRun)                 a node started or finished its part of a test
//   "status" (testId)                          the status of a test changed
//   "sample" (nodeId, ts, { sensor: value }) an agent reported sensor values
export const bus = new EventEmitter()
bus.setMaxListeners(0)

// nodeId: the node a line belongs to (null for lines of the runner itself)
export type LogEntry = { id: number; ts: number; line: string; nodeId: string | null }

// status: waiting (not started yet), running, passed, failed, stopped, lost
export type NodeRun = {
  nodeId: string
  name: string
  status: string
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}
