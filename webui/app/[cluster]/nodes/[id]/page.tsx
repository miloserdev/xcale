import { AutoRefresh } from "@/components/auto-refresh"
import { SyncBadge } from "@/components/sync-badge"
import { LoadavgChart } from "@/components/loadavg-chart"
import { Badge } from "@/components/ui/badge"
import {
  Card,
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
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { getNode, getNodeLatest, getNodeLoadavg } from "@/lib/api"
import { formatUptime } from "@/lib/format"

export default async function Page({
  params,
}: {
  params: Promise<{ cluster: string; id: string }>
}) {
  const { cluster, id } = await params
  const [node, latest, loadavg] = await Promise.all([
    getNode(cluster, id),
    getNodeLatest(cluster, id),
    getNodeLoadavg(cluster, id),
  ])
  const { info } = node

  const rows: [string, string][] = [
    ["Last IP", node.lastIp ?? "never connected"],
    ["MAC", node.lastMac ?? "—"],
    ["OS", [info.os, info.kernel].filter(Boolean).join(", ") || "—"],
    [
      "CPU",
      info.cpu
        ? `${info.cpu}${info.threads ? ` (${info.threads} threads)` : ""}`
        : "—",
    ],
    [
      "Memory",
      info.memory_kb ? `${Math.round(info.memory_kb / 1024 / 1024)} GB` : "—",
    ],
    ["Uptime", formatUptime(info.boot_ts)],
    ["Agent", node.agentVersion ? `v${node.agentVersion}` : "—"],
  ]

  const width = Math.max(0, ...latest.map((s) => s.id.length))
  const consoleText = latest.length
    ? latest
        .map(
          (s) =>
            `${s.id.padEnd(width)}  ${s.value.toFixed(1).padStart(8)} ${s.unit}  ${s.label}`
        )
        .join("\n")
    : "No sensor data yet"

  return (
    <div className="flex flex-col gap-4 p-4 pt-0">
      <AutoRefresh enabled={node.online} />
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-medium">{node.name}</h1>
        <Badge variant={node.online ? "default" : "destructive"}>
          {node.online ? "online" : "offline"}
        </Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Parameters</CardTitle>
            <CardDescription>{node.id}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              <dt className="text-muted-foreground">Scripts</dt>
              <dd className="flex flex-col gap-1">
                <span>
                  <SyncBadge node={node} />
                </span>
                {node.syncError && (
                  <span className="text-xs text-destructive">
                    {node.syncError}
                  </span>
                )}
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Load average</CardTitle>
            <CardDescription>1 / 5 / 15 min, last hour</CardDescription>
          </CardHeader>
          <CardContent>
            <LoadavgChart data={loadavg} />
          </CardContent>
        </Card>
      </div>
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>Sensors</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={consoleText} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent>{consoleText}</CodeBlockContent>
      </CodeBlock>
    </div>
  )
}
