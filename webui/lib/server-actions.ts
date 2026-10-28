"use server"

import {
  ApiError,
  ApiUnauthorizedError,
  apiMutate,
  fetchAgentToken,
} from "@/lib/api"
import { redirect } from "next/navigation"

export type TokenResult = { token: string | null; error?: string }

async function guarded(fn: () => Promise<string | null>): Promise<TokenResult> {
  try {
    return { token: await fn() }
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) redirect("/login")
    if (error instanceof ApiError)
      return {
        token: null,
        error:
          error.message === "not found"
            ? "Not found. If the xcale server was updated recently, restart it."
            : error.message,
      }
    return { token: null, error: "The xcale server is not responding." }
  }
}

export async function revealAgentToken(cluster: string) {
  return guarded(async () => (await fetchAgentToken(cluster)).token)
}

export async function regenerateAgentToken(cluster: string) {
  return guarded(
    async () =>
      (
        await apiMutate<{ token: string }>(
          "POST",
          `/api/clusters/${encodeURIComponent(cluster)}/token`
        )
      ).token
  )
}
