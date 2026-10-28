"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronDownIcon, XIcon } from "lucide-react"

import { useCluster } from "@/components/cluster-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  hasTestFilters,
  parseTestFilters,
  testStatuses,
} from "@/lib/test-filters"

export function TestsFilters() {
  const { activeCluster } = useCluster()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const filters = parseTestFilters(searchParams)

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  function toggle(key: "status" | "node", current: string[], value: string) {
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]
    update(key, next.join(","))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        placeholder="Search by name or id"
        className="w-56"
        defaultValue={filters.q}
        onChange={(event) => update("q", event.target.value)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Status{filters.status.length > 0 && ` (${filters.status.length})`}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {testStatuses.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={filters.status.includes(status)}
              onCheckedChange={() => toggle("status", filters.status, status)}
            >
              {status}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Node{filters.node.length > 0 && ` (${filters.node.length})`}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {activeCluster.nodes.map((node) => (
            <DropdownMenuCheckboxItem
              key={node.id}
              checked={filters.node.includes(node.id)}
              onCheckedChange={() =>
                toggle("node", filters.node, node.id)
              }
            >
              {node.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Input
        type="date"
        aria-label="From date"
        className="w-40"
        value={filters.from}
        onChange={(event) => update("from", event.target.value)}
      />
      <Input
        type="date"
        aria-label="To date"
        className="w-40"
        value={filters.to}
        onChange={(event) => update("to", event.target.value)}
      />
      {hasTestFilters(filters) && (
        <Button
          variant="ghost"
          onClick={() => router.replace(pathname, { scroll: false })}
        >
          <XIcon />
          Reset
        </Button>
      )}
    </div>
  )
}
