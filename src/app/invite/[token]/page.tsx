'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Lookup =
  | { state: 'loading' }
  | { state: 'invalid' }
  | { state: 'valid'; organizationName: string; email: string; role: string }

export default function InvitePage() {
  const params = useParams<{ token: string }>()
  const token = typeof params.token === 'string' ? params.token : ''
  const { user, loading: authLoading } = useSupabase()
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' })
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/invitations/lookup?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return
        setLookup(data?.valid
          ? { state: 'valid', organizationName: data.organizationName, email: data.email, role: data.role }
          : { state: 'invalid' })
      })
      .catch(() => alive && setLookup({ state: 'invalid' }))
    return () => { alive = false }
  }, [token])

  const accept = async () => {
    setAccepting(true)
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error || 'Could not accept the invitation.'); setAccepting(false); return }
      // Full reload so server auth context picks up the new workspace/role.
      window.location.href = '/dashboard?auth=success'
    } catch {
      toast.error('Could not accept the invitation.')
      setAccepting(false)
    }
  }

  const returnTo = `/invite/${token}`

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/backstory-logo-white.svg" alt="Backstory" className="mx-auto mb-6 h-7" />
        </div>

        <Card className="shadow-3">
          {lookup.state === 'loading' || authLoading ? (
            <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Checking your invitation…
            </CardContent>
          ) : lookup.state === 'invalid' ? (
            <>
              <CardHeader>
                <CardTitle>Invitation not found</CardTitle>
                <CardDescription>This invitation is invalid or has expired. Ask your admin to send a new one.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline" className="w-full"><Link href="/auth/login">Go to sign in</Link></Button>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>Join {lookup.organizationName}</CardTitle>
                <CardDescription>
                  You’ve been invited to join <strong>{lookup.organizationName}</strong> on Backstory as {lookup.role === 'ADMIN' ? 'an admin' : 'a member'}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {user ? (
                  <>
                    <Button className="w-full" loading={accepting} onClick={accept}>Join {lookup.organizationName}</Button>
                    <p className="text-center text-xs text-muted-foreground">Signed in as {user.email}</p>
                  </>
                ) : (
                  <>
                    <Button asChild className="w-full">
                      <Link href={`/auth/signup?return_to=${encodeURIComponent(returnTo)}`}>Create your account</Link>
                    </Button>
                    <Button asChild variant="outline" className="w-full">
                      <Link href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}>I already have an account</Link>
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">Invitation sent to {lookup.email}</p>
                  </>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
