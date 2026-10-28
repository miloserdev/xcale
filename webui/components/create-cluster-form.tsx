"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { createClusterAction, type FormState } from "@/lib/cluster-actions"

export function CreateClusterForm() {
  const [state, formAction, pending] = React.useActionState<
    FormState,
    FormData
  >(createClusterAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cluster-name">Name</FieldLabel>
          <Input
            id="cluster-name"
            name="name"
            required
            autoFocus
            autoComplete="off"
            maxLength={64}
            pattern="[A-Za-z0-9_][A-Za-z0-9_\-]*"
            placeholder="thermal_stand_0"
          />
          <FieldDescription>
            Letters, digits, _ and -, up to 64 characters. The name is part of
            the address and cannot be changed later.
          </FieldDescription>
        </Field>
      </FieldGroup>
      {state?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create cluster"}
        </Button>
      </div>
    </form>
  )
}
