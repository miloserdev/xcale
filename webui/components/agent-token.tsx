"use client"

import * as React from "react"
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshCwIcon,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  regenerateAgentToken,
  revealAgentToken,
  type TokenResult,
} from "@/lib/server-actions"

const mask = "•".repeat(48)

// The token is fetched only when it is shown or copied, so it is not part of the page itself.
export function AgentToken({ cluster }: { cluster: string }) {
  const [token, setToken] = React.useState<string | null>(null)
  const [exists, setExists] = React.useState(true)
  const [visible, setVisible] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const input = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // Returns the token, loading it first if needed.
  async function load(): Promise<string | null> {
    if (token) return token
    const result = await revealAgentToken(cluster)
    return apply(result)
  }

  function apply(result: TokenResult) {
    setError(result.error)
    setToken(result.token)
    setExists(result.token !== null)
    return result.token
  }

  function toggle() {
    if (visible) return setVisible(false)
    startTransition(async () => {
      if (await load()) setVisible(true)
    })
  }

  function copy() {
    startTransition(async () => {
      const value = await load()
      if (!value) return
      try {
        await navigator.clipboard.writeText(value)
        setCopied(true)
      } catch {
        // clipboard needs https or localhost: show the token to copy it by hand
        setVisible(true)
        setError("Copying is not allowed here. Select the token and copy it.")
        requestAnimationFrame(() => input.current?.select())
      }
    })
  }

  function regenerate() {
    startTransition(async () => {
      const value = apply(await regenerateAgentToken(cluster))
      setVisible(value !== null)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {exists ? (
        <div className="flex items-center gap-2">
          <Input
            ref={input}
            readOnly
            aria-label="Agent token"
            className="font-mono"
            type={visible ? "text" : "password"}
            value={visible && token ? token : mask}
            onFocus={(event) => visible && event.currentTarget.select()}
          />
          <Button
            variant="outline"
            size="icon"
            disabled={pending}
            aria-label={visible ? "Hide token" : "Show token"}
            onClick={toggle}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <Button variant="outline" disabled={pending} onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The cluster has no token yet. Generate one to connect agents.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <AlertDialogTrigger
            render={<Button variant="outline" size="sm" disabled={pending} />}
          >
            <RefreshCwIcon />
            {exists ? "Regenerate" : "Generate"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {exists ? "Regenerate the token?" : "Generate a token?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {exists
                  ? "The current token stops working. Connected agents keep running until they reconnect, then every agent of the cluster needs the new token."
                  : "The token is shown once you press Show or Copy."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setDialogOpen(false)
                  regenerate()
                }}
              >
                {exists ? "Regenerate" : "Generate"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  )
}
