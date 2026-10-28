"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import type { ScriptFileResult } from "@/lib/api"
import {
  createScriptAction,
  deleteScriptAction,
  renameScriptAction,
  replaceScriptAction,
  saveScriptAction,
  uploadScriptsAction,
  type ScriptResult,
} from "@/lib/script-actions"
import type { ScriptFile } from "@/lib/types"

// --- the file tree ---

type TreeNode = {
  name: string
  path: string
  size?: number
  children?: TreeNode[]
}

function buildTree(files: ScriptFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let node = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/")
      if (i === parts.length - 1) {
        node.children!.push({ name: part, path, size: file.size })
        return
      }
      let dir = node.children!.find((c) => c.children && c.name === part)
      if (!dir) {
        dir = { name: part, path, children: [] }
        node.children!.push(dir)
      }
      node = dir
    })
  }
  const sort = (n: TreeNode) => {
    n.children?.sort(
      (a, b) =>
        Number(!!b.children) - Number(!!a.children) ||
        a.name.localeCompare(b.name)
    )
    n.children?.forEach(sort)
  }
  sort(root)
  return root.children!
}

const folderOf = (path: string | null) =>
  path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""

function RowMenu({
  onRename,
  onDelete,
}: {
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Actions"
            className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon />
          Rename or move
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Tree({
  nodes,
  base,
  selected,
  onRename,
  onDelete,
}: {
  nodes: TreeNode[]
  base: string
  selected: string | null
  onRename: (path: string) => void
  onDelete: (path: string) => void
}) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) =>
        node.children ? (
          <li key={node.path}>
            <Collapsible
              defaultOpen={
                !!selected?.startsWith(`${node.path}/`) ||
                !node.path.includes("/")
              }
            >
              <div className="group/row flex items-center gap-1">
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1 justify-start gap-1.5 px-1.5"
                    />
                  }
                >
                  <ChevronRightIcon className="transition-transform in-data-panel-open:rotate-90" />
                  <FolderIcon />
                  <span className="truncate">{node.name}</span>
                </CollapsibleTrigger>
                <RowMenu
                  onRename={() => onRename(node.path)}
                  onDelete={() => onDelete(node.path)}
                />
              </div>
              <CollapsibleContent>
                <div className="ml-3 border-l pl-1">
                  <Tree
                    nodes={node.children}
                    base={base}
                    selected={selected}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </li>
        ) : (
          <li key={node.path} className="group/row flex items-center gap-1">
            <Link
              href={`${base}?file=${encodeURIComponent(node.path)}`}
              scroll={false}
              aria-current={selected === node.path ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
            >
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{node.name}</span>
            </Link>
            <RowMenu
              onRename={() => onRename(node.path)}
              onDelete={() => onDelete(node.path)}
            />
          </li>
        )
      )}
    </ul>
  )
}

// --- viewing and editing a file ---

function languageOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return (
    (
      {
        sh: "bash",
        bash: "bash",
        py: "python",
        json: "json",
        yml: "yaml",
        yaml: "yaml",
        md: "markdown",
        js: "javascript",
        ts: "typescript",
      } as Record<string, string>
    )[ext] ?? "text"
  )
}

function Highlighted({ content, path }: { content: string; path: string }) {
  const lines = useHighlightedCode(content, languageOf(path))
  return (
    <CodeBlockContent lineNumbers className="max-h-[65vh]">
      {lines.map((line, i) => (
        <CodeBlockLine key={i}>{line}</CodeBlockLine>
      ))}
    </CodeBlockContent>
  )
}

function FileEditor({
  cluster,
  file,
  startEditing,
}: {
  cluster: string
  file: Extract<ScriptFileResult, { ok: true }>
  startEditing: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  // While editing, `base` is the version the draft started from: if someone else changes
  // the file meanwhile, saving is refused instead of overwriting their change, and a
  // refresh of the page does not touch the draft.
  const [session, setSession] = React.useState<{
    base: string
    draft: string
  } | null>(startEditing ? { base: file.sha256, draft: file.content } : null)
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const changed = session !== null && session.draft !== file.content

  function save() {
    if (!session || !changed || pending) return
    setError(undefined)
    startTransition(async () => {
      const result = await saveScriptAction(
        cluster,
        file.path,
        session.base,
        session.draft
      )
      if (result.error) return setError(result.error)
      setSession(null)
      router.replace(`${pathname}?file=${encodeURIComponent(file.path)}`, {
        scroll: false,
      })
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono">{file.path}</CodeBlockTitle>
          <Badge variant="outline">{file.size} bytes</Badge>
          {file.executable && <Badge variant="secondary">executable</Badge>}
          <CodeBlockActions className="static m-0 opacity-100">
            {session ? (
              <>
                <Button size="sm" disabled={!changed || pending} onClick={save}>
                  <SaveIcon />
                  {pending ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setSession(null)
                    setError(undefined)
                  }}
                >
                  <XIcon />
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <CodeBlockCopyButton value={file.content} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSession({ base: file.sha256, draft: file.content })
                  }
                >
                  <PencilIcon />
                  Edit
                </Button>
              </>
            )}
          </CodeBlockActions>
        </CodeBlockHeader>
        {session ? (
          <Textarea
            value={session.draft}
            onChange={(event) =>
              setSession({ ...session, draft: event.target.value })
            }
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "s"
              ) {
                event.preventDefault()
                save()
              }
            }}
            spellCheck={false}
            autoFocus
            aria-label={`Edit ${file.path}`}
            className="min-h-[50vh] rounded-none border-0 font-mono text-sm leading-relaxed focus-visible:ring-0"
          />
        ) : (
          <Highlighted content={file.content} path={file.path} />
        )}
      </CodeBlock>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 text-sm text-destructive"
        >
          {error}
          {error.includes("changed by someone") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // take the current version of the file; the draft is dropped
                setSession({ base: file.sha256, draft: file.content })
                setError(undefined)
              }}
            >
              Reload the file
            </Button>
          )}
        </div>
      )}
      {session && (
        <p className="text-xs text-muted-foreground">
          Ctrl+S saves. After saving the directory is copied to the nodes.
        </p>
      )}
    </div>
  )
}

// --- the workspace ---

type Target =
  | { kind: "new" }
  | { kind: "rename"; path: string }
  | { kind: "delete"; path: string }
  | null

export function ScriptsWorkspace({
  cluster,
  files,
  selected,
  file,
  startEditing,
}: {
  cluster: string
  files: ScriptFile[]
  selected: string | null
  file: ScriptFileResult | null
  startEditing: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [target, setTarget] = React.useState<Target>(null)
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const upload = React.useRef<HTMLInputElement>(null)
  const replace = React.useRef<HTMLInputElement>(null)
  const tree = React.useMemo(() => buildTree(files), [files])
  const open = (path: string | null, edit = false) =>
    router.push(
      path
        ? `${pathname}?file=${encodeURIComponent(path)}${edit ? "&edit=1" : ""}`
        : pathname,
      { scroll: false }
    )

  function ask(next: Target, initial = "") {
    setError(undefined)
    setName(initial)
    setTarget(next)
  }

  function run(
    action: () => Promise<ScriptResult>,
    then?: (r: ScriptResult) => void
  ) {
    setError(undefined)
    startTransition(async () => {
      const result = await action()
      if (result.error) return setError(result.error)
      setTarget(null)
      then?.(result)
    })
  }

  const submitName = (event: React.FormEvent) => {
    event.preventDefault()
    const path = name.trim().replace(/^\/+/, "")
    if (!target) return
    if (target.kind === "new")
      run(
        () =>
          createScriptAction(
            cluster,
            path,
            path.endsWith(".sh") ? "#!/bin/bash\n" : ""
          ),
        () => open(path, true)
      )
    else if (target.kind === "rename") {
      const from = target.path
      run(
        () => renameScriptAction(cluster, from, path),
        () => {
          if (selected === from || selected?.startsWith(`${from}/`))
            open(
              selected === from ? path : `${path}${selected.slice(from.length)}`
            )
        }
      )
    }
  }

  const confirmDelete = () => {
    if (target?.kind !== "delete") return
    const path = target.path
    run(
      () => deleteScriptAction(cluster, path),
      () => {
        if (selected === path || selected?.startsWith(`${path}/`)) open(null)
      }
    )
  }

  const folder = folderOf(selected)

  return (
    <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>
            {files.length} {files.length === 1 ? "file" : "files"}
          </CardDescription>
          <CardAction className="flex gap-1">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="New file"
              onClick={() => ask({ kind: "new" }, folder ? `${folder}/` : "")}
            >
              <PlusIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Upload files"
              onClick={() => upload.current?.click()}
            >
              <UploadIcon />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {tree.length ? (
            <Tree
              nodes={tree}
              base={pathname}
              selected={selected}
              onRename={(p) => ask({ kind: "rename", path: p }, p)}
              onDelete={(p) => ask({ kind: "delete", path: p })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No files yet. Create a script with the + button or upload files.
            </p>
          )}
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = event.target.files
              if (!picked?.length) return
              const form = new FormData()
              Array.from(picked).forEach((f) => form.append("files", f))
              event.target.value = ""
              run(
                () => uploadScriptsAction(cluster, folder, form),
                (r) => r.path && open(r.path)
              )
            }}
          />
        </CardContent>
      </Card>

      <div className="min-w-0">
        {!selected && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            Select a file to view it. Everything in this directory is copied to
            the nodes of the cluster.
          </p>
        )}
        {selected && file && !file.ok && (
          <div className="flex flex-col items-start gap-3 rounded-lg border p-4">
            <p className="font-mono text-sm">{selected}</p>
            <p className="text-sm text-muted-foreground">{file.error}</p>
            {file.status !== 404 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => replace.current?.click()}
                >
                  <UploadIcon />
                  Replace with an uploaded file
                </Button>
                <input
                  ref={replace}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const picked = event.target.files?.[0]
                    if (!picked) return
                    const form = new FormData()
                    form.append("file", picked)
                    event.target.value = ""
                    run(
                      () => replaceScriptAction(cluster, selected, form),
                      () => router.refresh()
                    )
                  }}
                />
              </>
            )}
          </div>
        )}
        {selected && file?.ok && (
          <FileEditor
            key={file.path}
            cluster={cluster}
            file={file}
            startEditing={startEditing}
          />
        )}
        {error && !target && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <Dialog
        open={target?.kind === "new" || target?.kind === "rename"}
        onOpenChange={(o) => !o && setTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.kind === "rename" ? "Rename or move" : "New file"}
            </DialogTitle>
            <DialogDescription>
              The path may contain folders, for example tests/stress.sh. Folders
              are created as needed.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitName} className="flex flex-col gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="tests/stress.sh"
              className="font-mono"
            />
            {error && target && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={pending}>
                {target?.kind === "rename" ? "Rename" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={target?.kind === "delete"}
        onOpenChange={(o) => !o && setTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {target?.kind === "delete" ? target.path : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The file (or folder with everything in it) is removed here and on
              the nodes after the next sync. Tests that use it will fail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && target?.kind === "delete" && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
