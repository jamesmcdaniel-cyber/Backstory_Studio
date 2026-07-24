'use client'

import { useEffect } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { GoogleButton } from '@/components/auth/google-button'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const { user, loading: authLoading } = useSupabase()
  const router = useRouter()

  // Where to land after sign-in: honor `return_to` from the deep link (e.g. a
  // flow someone was invited to at /flows/<id>) so invitees reach that page
  // instead of always being dumped on the dashboard/Agent HQ. Same-origin
  // relative paths only — never an absolute URL (open-redirect guard).
  const safeReturnTo = (): string => {
    if (typeof window === 'undefined') return '/dashboard'
    const raw = new URLSearchParams(window.location.search).get('return_to')
    return raw && /^\/(?!\/)/.test(raw) && !raw.includes('\\') ? raw : '/dashboard'
  }

  // Handle Supabase email verification redirected to wrong URL
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search)
      const tokenHash = urlParams.get('token_hash')
      const type = urlParams.get('type')
      
      // If this is a Supabase email verification that was redirected to login page, redirect to callback
      if (tokenHash && type) {
        const callbackUrl = new URL('/auth/callback', window.location.origin)
        callbackUrl.searchParams.set('token_hash', tokenHash)
        callbackUrl.searchParams.set('type', type)
        
        // Preserve any other parameters
        const returnTo = urlParams.get('return_to')
        if (returnTo) {
          callbackUrl.searchParams.set('next', returnTo)
        }
        
        window.location.href = callbackUrl.toString()
        return
      }
    }
    
    // Redirect if already authenticated — to the invited page when present.
    if (!authLoading && user) {
      router.push(safeReturnTo())
    }
  }, [user, authLoading, router])

  // Show loading spinner while checking auth state
  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
        <div className="flex items-center gap-2 text-white">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-white motion-reduce:animate-none" />
          <span>Loading…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/backstory-symbol-white.png" alt="Backstory" className="mx-auto mb-6 h-7" />
          <h1 className="text-2xl font-semibold text-white">Welcome back</h1>
          <p className="mt-1 text-white/70">Sign in to your Backstory workspace.</p>
        </div>

        <Card className="shadow-3">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Continue with your People.ai or Backstory company Google account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GoogleButton label="Sign in with Google" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
