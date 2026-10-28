"use client"

import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { sensorNames } from "@/lib/sensor-names"
import type { Telemetry, TestSensor } from "@/lib/types"

const titles: Record<string, string> = {
  temperature: "Temperature",
  fan: "Fan speed",
  power: "Power",
  voltage: "Voltage",
  current: "Current",
  energy: "Energy",
  frequency: "CPU frequency",
  load: "Load average",
  humidity: "Humidity",
}

const title = (kind: string) =>
  titles[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)

// one point per minute
const ranges = [
  { label: "5m", points: 5 },
  { label: "15m", points: 15 },
  { label: "30m", points: 30 },
  { label: "All", points: Infinity },
]

// golden-angle hues keep neighbouring lines apart however many sensors there are
const color = (i: number) => `hsl(${Math.round((i * 137.5) % 360)} 65% 50%)`

function KindChart({
  kind,
  sensors,
  data,
  multiNode,
  names: displayNames,
}: {
  kind: string
  sensors: TestSensor[]
  data: Record<string, number | string>[]
  multiNode: boolean
  names: Map<string, string>
}) {
  const name = (s: TestSensor) =>
    `${multiNode ? `${s.node} · ` : ""}${displayNames.get(s.key) ?? s.label}`
  const [hidden, setHidden] = React.useState<Set<string>>(new Set())
  // chart keys are indexes: sensor keys contain characters that do not work in CSS names
  const names = sensors.map((_, i) => `s${i}`)
  const rows = React.useMemo(
    () =>
      data.map((point) => {
        const row: Record<string, number | string> = {
          t: point.t,
          time: point.time,
        }
        sensors.forEach((s, i) => {
          if (point[s.key] !== undefined) row[names[i]] = point[s.key]
        })
        return row
      }),
    [data, sensors, names]
  )
  const config = Object.fromEntries(
    sensors.map((s, i) => [
      names[i],
      {
        label: name(s),
        color: color(i),
      },
    ])
  ) satisfies ChartConfig
  const unit = sensors[0]?.unit

  function toggle(key: string) {
    setHidden((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title(kind)}</CardTitle>
        <CardDescription>
          {unit ? `${unit} · ` : ""}
          {sensors.length} sensor{sensors.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <LineChart data={rows} margin={{ left: 0, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              domain={["auto", "auto"]}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {sensors.map((s, i) =>
              hidden.has(s.key) ? null : (
                <Line
                  key={s.key}
                  dataKey={names[i]}
                  type="monotone"
                  stroke={`var(--color-${names[i]})`}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )
            )}
          </LineChart>
        </ChartContainer>
        <div className="flex max-h-28 flex-wrap content-start gap-1.5 overflow-y-auto">
          {sensors.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              title={s.id}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
                hidden.has(s.key) ? "text-muted-foreground opacity-50" : ""
              }`}
            >
              <span
                className="size-2 rounded-full"
                style={{ background: color(i) }}
              />
              {name(s)}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function TestCharts({
  telemetry,
  emptyMessage = "No sensor data recorded for this test.",
}: {
  telemetry: Telemetry
  emptyMessage?: string
}) {
  const [range, setRange] = React.useState(ranges[3])
  const multiNode = telemetry.nodes.length > 1
  const kinds = Object.keys(telemetry.series)
  const names = React.useMemo(
    () => sensorNames(telemetry.sensors),
    [telemetry.sensors]
  )

  if (!kinds.length) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Range</span>
        {ranges.map((item) => (
          <Button
            key={item.label}
            size="sm"
            variant={item === range ? "default" : "outline"}
            onClick={() => setRange(item)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {kinds.map((kind) => {
          const sensors = telemetry.sensors.filter((s) => s.kind === kind)
          if (!sensors.length) return null
          return (
            <KindChart
              key={kind}
              kind={kind}
              sensors={sensors}
              data={telemetry.series[kind].slice(-range.points)}
              multiNode={multiNode}
              names={names}
            />
          )
        })}
      </div>
    </div>
  )
}
