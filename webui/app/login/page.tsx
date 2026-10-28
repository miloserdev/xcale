import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { LoginForm } from "@/components/login-form"
import { getMe } from "@/lib/api"
import { safeNext, sessionCookie } from "@/lib/session"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const next = safeNext((await searchParams).next)

  // Already signed in: go on to the page that was asked for.
  if ((await cookies()).has(sessionCookie)) {
    const signedIn = await getMe().then(
      () => true,
      () => false
    )
    if (signedIn) redirect(next)
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm next={next} />
      </div>
    </div>
  )
}
