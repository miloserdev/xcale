"use client"

import * as React from "react"
import { ArrowDownToLineIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { Input } from "@/components/ui/input"

function lineVariant(line: string) {
  if (line.includes("ERROR")) return "removed" as const
  if (line.includes("WARN")) return "highlighted" as const
  return "default" as const
}

export function TestConsole({
  lines,
  title = "Console",
}: {
  lines: string[]
  title?: string
}) {
  const [query, setQuery] = React.useState("")
  const [follow, setFollow] = React.useState(true)
  const ref = React.useRef<HTMLPreElement>(null)

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? lines.filter((line) => line.toLowerCase().includes(needle))
    : lines

  // Stick to the bottom while following; manual scroll up pauses it.
  React.useEffect(() => {
    const el = ref.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [visible, follow])

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <span className="text-xs text-muted-foreground">
          {visible.length}
          {needle && ` / ${lines.length}`} lines
        </span>
        <Input
          type="search"
          placeholder="Search log"
          className="ml-auto h-7 w-48"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {!follow && (
          <Button size="xs" variant="outline" onClick={() => setFollow(true)}>
            <ArrowDownToLineIcon />
            Follow
          </Button>
        )}
        <CodeBlockCopyButton value={visible.join("\n")} />
      </CodeBlockHeader>
      <CodeBlockContent
        ref={ref}
        className="max-h-80"
        onScroll={(event) => {
          const el = event.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {visible.length ? (
          visible.map((line, i) => (
            <CodeBlockLine key={i} variant={lineVariant(line)}>
              {line}
            </CodeBlockLine>
          ))
        ) : (
          <CodeBlockLine>
            {lines.length ? "No matching lines" : "No log yet"}
          </CodeBlockLine>
        )}
      </CodeBlockContent>
    </CodeBlock>
  )
}
