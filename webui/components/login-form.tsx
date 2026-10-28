"use client"

import * as React from "react"
import { cn } from "cn"
import { ServerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { loginAction, type LoginState } from "@/lib/auth-actions"

export function LoginForm({
  next,
  className,
  ...props
}: React.ComponentProps<"div"> & { next: string }) {
  const [state, formAction, pending] = React.useActionState<
    LoginState,
    FormData
  >(loginAction.bind(null, next), null)

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form action={formAction}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-8 items-center justify-center rounded-md">
              <ServerIcon className="size-6" />
            </div>
            <h1 className="text-xl font-bold">Sign in to xcale</h1>
            <FieldDescription>
              Use your account on the xcale server.
            </FieldDescription>
          </div>
          <Field>
            <FieldLabel htmlFor="username">Username</FieldLabel>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {state?.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <Field>
            <Button type="submit" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  )
}
