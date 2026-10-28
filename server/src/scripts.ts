import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

import { nameProblem } from "./names.ts"

// Every cluster has its own directory of scripts, configs and helper files. The agents
// copy it to their nodes (see agents.ts), and tests run from that copy.
export const scriptsRoot = resolve(process.env.XCALE_SCRIPTS_DIR ?? "data/scripts")
// copied into the directory of a new cluster
const examplesDir = resolve(import.meta.dirname, "../examples")

export const limits = {
  file: 5 * 1024 * 1024,
  total: 50 * 1024 * 1024,
  files: 2000,
  depth: 8,
}

// A path segment: no leading dot or dash, so hidden files never take part.
const segment = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

export function pathProblem(rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.length > 300) return "bad path"
  const parts = rel.split("/")
  if (parts.length > limits.depth) return "path is too deep"
  if (!parts.every((p) => segment.test(p)))
    return "use letters, digits, . _ - in names, not starting with . or -"
  return null
}

export function clusterDir(cluster: string) {
  const problem = nameProblem(cluster)
  if (problem) throw new Error(`invalid cluster name: ${problem}`)
  return join(scriptsRoot, cluster)
}

// Creates the directory of a cluster with the example scripts on first use.
export function ensureClusterDir(cluster: string) {
  const dir = clusterDir(cluster)
  if (existsSync(dir)) return dir
  mkdirSync(dir, { recursive: true })
  if (existsSync(examplesDir)) cpSync(examplesDir, dir, { recursive: true })
  return dir
}

export function removeClusterDir(cluster: string) {
  rmSync(clusterDir(cluster), { recursive: true, force: true })
}

// Absolute path of a file of the cluster; refuses anything that leaves the directory.
export function resolveFile(cluster: string, rel: string) {
  const problem = pathProblem(rel)
  if (problem) throw new Error(problem)
  const dir = ensureClusterDir(cluster)
  const path = resolve(dir, rel)
  if (!path.startsWith(dir + sep)) throw new Error("bad path")
  // a symlink inside must not lead out either
  if (existsSync(path) && !realpathSync(path).startsWith(realpathSync(dir) + sep))
    throw new Error("bad path")
  return path
}

export type ManifestFile = { path: string; size: number; sha256: string; mode: number }
export type Manifest = { version: string; files: ManifestFile[]; bytes: number }

// Files of the cluster directory with their hashes. `version` identifies the contents:
// nodes with the same version have identical directories.
export function buildManifest(cluster: string): Manifest {
  const dir = ensureClusterDir(cluster)
  const files: ManifestFile[] = []
  let bytes = 0

  const walk = (current: string, prefix: string, depth: number) => {
    if (depth > limits.depth) throw new Error("directory tree is too deep")
    for (const entry of readdirSync(current).sort()) {
      if (!segment.test(entry)) continue
      const full = join(current, entry)
      const stat = lstatSync(full)
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (stat.isDirectory()) walk(full, rel, depth + 1)
      else if (stat.isFile()) {
        if (stat.size > limits.file)
          throw new Error(`${rel} is larger than ${limits.file / 1024 / 1024} MB`)
        bytes += stat.size
        if (bytes > limits.total || files.length >= limits.files)
          throw new Error("the scripts directory is too large")
        files.push({
          path: rel,
          size: stat.size,
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
          mode: stat.mode & 0o100 ? 0o755 : 0o644,
        })
      }
    }
  }
  walk(dir, "", 0)

  const version = createHash("sha256")
    .update(files.map((f) => `${f.path}\0${f.sha256}\0${f.mode}\n`).join(""))
    .digest("hex")
    .slice(0, 12)
  return { version, files, bytes }
}

export function fileExists(cluster: string, rel: string) {
  try {
    return lstatSync(resolveFile(cluster, rel)).isFile()
  } catch {
    return false
  }
}

// --- editing (the file manager of the web UI) ---

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")

export class ScriptsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// A readable text file: UTF-8 without NUL bytes, up to 1 MB.
export function readText(cluster: string, rel: string) {
  let path: string
  try {
    path = resolveFile(cluster, rel)
  } catch (error) {
    throw new ScriptsError(400, (error as Error).message)
  }
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new ScriptsError(404, "not found")
  const data = readFileSync(path)
  if (data.length > 1024 * 1024) throw new ScriptsError(413, "the file is larger than 1 MB, it cannot be edited here")
  const text = data.toString("utf8")
  if (data.includes(0) || Buffer.from(text, "utf8").compare(data) !== 0)
    throw new ScriptsError(415, "binary file: it can be replaced but not edited here")
  return { content: text, sha256: sha256(data), size: data.length, executable: !!(lstatSync(path).mode & 0o100) }
}

// Writes a file atomically. `base` is the sha256 the editor started from, or "new" for a
// file that must not exist yet: a file changed meanwhile by someone else is not overwritten.
export function writeFileChecked(
  cluster: string,
  rel: string,
  data: Buffer,
  base: string,
  executable?: boolean
) {
  let path: string
  try {
    path = resolveFile(cluster, rel)
  } catch (error) {
    throw new ScriptsError(400, (error as Error).message)
  }
  if (data.length > limits.file) throw new ScriptsError(413, `the file is larger than ${limits.file / 1024 / 1024} MB`)
  const exists = existsSync(path)
  if (exists && !lstatSync(path).isFile()) throw new ScriptsError(409, "a directory with this name exists")
  if (base === "new" && exists) throw new ScriptsError(409, "a file with this name already exists")
  // "any" replaces the file whatever it contains (an upload)
  if (base !== "new" && base !== "any") {
    if (!exists) throw new ScriptsError(409, "the file was deleted meanwhile")
    if (sha256(readFileSync(path)) !== base)
      throw new ScriptsError(409, "the file was changed by someone else, reload it first")
  }
  if (!exists) {
    // every directory on the way must be a real directory, never a symlink
    const root = ensureClusterDir(cluster)
    let current = root
    for (const part of dirname(rel) === "." ? [] : dirname(rel).split("/")) {
      current = join(current, part)
      if (existsSync(current)) {
        if (!lstatSync(current).isDirectory()) throw new ScriptsError(409, `${part} is not a directory`)
      } else mkdirSync(current)
    }
    if (buildManifest(cluster).files.length >= limits.files) throw new ScriptsError(413, "too many files")
  }
  const mode = executable ?? (exists ? !!(lstatSync(path).mode & 0o100) : rel.endsWith(".sh"))
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  chmodSync(tmp, mode ? 0o755 : 0o644)
  renameSync(tmp, path)
  return { sha256: sha256(data), size: data.length }
}

export function deleteEntry(cluster: string, rel: string) {
  let path: string
  try {
    path = resolveFile(cluster, rel)
  } catch (error) {
    throw new ScriptsError(400, (error as Error).message)
  }
  if (!existsSync(path)) throw new ScriptsError(404, "not found")
  rmSync(path, { recursive: true, force: true })
}

export function renameEntry(cluster: string, from: string, to: string) {
  let source: string, target: string
  try {
    source = resolveFile(cluster, from)
    target = resolveFile(cluster, to)
  } catch (error) {
    throw new ScriptsError(400, (error as Error).message)
  }
  if (!existsSync(source)) throw new ScriptsError(404, "not found")
  if (existsSync(target)) throw new ScriptsError(409, "something with this name already exists")
  if (target.startsWith(source + sep)) throw new ScriptsError(400, "cannot move a folder into itself")
  mkdirSync(dirname(target), { recursive: true })
  renameSync(source, target)
}
