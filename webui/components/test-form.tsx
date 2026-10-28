"use client"

import * as React from "react"
import { PlusIcon, XIcon } from "lucide-react"

import {
  createTestAction,
  type ActionState,
} from "@/app/[cluster]/tests/actions"
import { useCluster } from "@/components/cluster-provider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { NodesTable } from "@/components/nodes-table"
import { Input } from "@/components/ui/input"
import type { Test } from "@/lib/types"

export function TestForm({
  scripts,
  initial,
  preselected,
}: {
  scripts: string[]
  initial?: Test
  preselected?: string[]
}) {
  const { activeCluster } = useCluster()
  const [state, formAction, pending] = React.useActionState<
    ActionState,
    FormData
  >(createTestAction.bind(null, activeCluster.id), null)
  const [params, setParams] = React.useState(
    Object.entries(initial?.configs ?? {}).map(([key, value], i) => ({
      id: i,
      key,
      value,
    }))
  )
  const nextId = React.useRef(params.length)

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            name="name"
            required
            maxLength={100}
            defaultValue={initial?.name}
            placeholder="Thermal soak 30m"
          />
        </Field>

        <FieldSet>
          <FieldLegend variant="label">Nodes</FieldLegend>
          <FieldDescription>
            The scripts run on all selected nodes in parallel. Select nodes one by one or a whole group.
          </FieldDescription>
          <NodesTable
            nodes={activeCluster.nodes}
            picker={{ initial: initial?.nodeIds ?? preselected }}
          />
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">Scripts</FieldLegend>
          <FieldDescription>
            Run one after another on each node; the first failure stops the
            rest on that node. The scripts are in the Scripts section of the
            cluster; they are copied to the nodes before the test starts.
          </FieldDescription>
          {scripts.length ? (
            scripts.map((script) => (
              <Field key={script} orientation="horizontal">
                <Checkbox
                  id={`script-${script}`}
                  name="scriptsPaths"
                  value={script}
                  defaultChecked={initial?.scriptsPaths.includes(script)}
                />
                <FieldLabel htmlFor={`script-${script}`} className="font-mono">
                  {script}
                </FieldLabel>
              </Field>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No scripts yet. Add a .sh file on the Scripts page of the cluster.
            </p>
          )}
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">Parameters</FieldLegend>
          <FieldDescription>
            Passed to the scripts as XCALE_&lt;NAME&gt; environment variables,
            for example duration = 30m.
          </FieldDescription>
          {params.map((param) => (
            <div key={param.id} className="flex items-center gap-2">
              <Input
                name="cfgKey"
                aria-label="Parameter name"
                placeholder="duration"
                defaultValue={param.key}
                pattern="[A-Za-z][A-Za-z0-9_]*"
              />
              <Input
                name="cfgValue"
                aria-label="Parameter value"
                placeholder="30m"
                defaultValue={param.value}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove parameter"
                onClick={() =>
                  setParams((list) => list.filter((p) => p.id !== param.id))
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setParams((list) => [
                  ...list,
                  { id: nextId.current++, key: "", value: "" },
                ])
              }
            >
              <PlusIcon />
              Add parameter
            </Button>
          </div>
        </FieldSet>
      </FieldGroup>

      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Starting…" : "Start test"}
        </Button>
      </div>
    </form>
  )
}
