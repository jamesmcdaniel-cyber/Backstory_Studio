'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowRight, Check } from 'lucide-react'

type SetupStatusState = {
  entitled: boolean
  backstoryConnected: boolean
  backstoryConnectionId: string | null
  backstoryServerUrl: string | null
  loading: boolean
}

const initialStatus: SetupStatusState = {
  entitled: false,
  backstoryConnected: false,
  backstoryConnectionId: null,
  backstoryServerUrl: null,
  loading: true,
}

const oauthErrorCodes = new Set(['oauth', 'oauth_state', 'oauth_start', 'oauth_params'])

/**
 * The entitlement gate's front door. Signed-in users without both an active
 * Backstory Sales AI connection AND an authorized Backstory MCP connection
 * land here. Step 1 runs the People.ai OAuth flow (Glass → Salesforce); step
 * 2 runs the Backstory MCP OAuth flow. Completing both unlocks the workspace.
 */
function ConnectInner() {
  const params = useSearchParams()
  const peopleaiStatus = params.get('peopleai')
  const connected = params.get('connected')
  const errorCode = params.get('error')

  const [status, setStatus] = useState<SetupStatusState>(initialStatus)

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (data?.success) {
          setStatus({
            entitled: Boolean(data.entitled),
            backstoryConnected: Boolean(data.backstoryConnected),
            backstoryConnectionId: data.backstoryConnectionId ?? null,
            backstoryServerUrl: data.backstoryServerUrl ?? null,
            loading: false,
          })
        } else {
          setStatus((prev) => ({ ...prev, loading: false }))
        }
      })
      .catch(() => {
        if (!cancelled) setStatus((prev) => ({ ...prev, loading: false }))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status.loading) return
    if (status.entitled && status.backstoryConnected) {
      const timer = window.setTimeout(() => {
        window.location.assign('/dashboard')
      }, 1200)
      return () => window.clearTimeout(timer)
    }
  }, [status.loading, status.entitled, status.backstoryConnected])

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-horizon-soft p-6">
      <div className="w-full max-w-md animate-fade-in-up rounded-xl border bg-white p-8 shadow-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/backstory-lockup-black.svg" alt="Backstory" className="h-6 w-auto" />

        <p className="eyebrow mt-8">Sales AI required</p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">
          Connect your Backstory account
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          Backstory Studio is available to Backstory Sales AI customers. Sign in
          with your Salesforce identity to link this workspace to your team —
          your agents will read Sales AI with your own permissions.
        </p>

        {peopleaiStatus === 'error' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>The connection didn&apos;t complete. Try again — if it keeps failing, contact support.</p>
          </div>
        )}
        {peopleaiStatus === 'team-mismatch' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>This workspace belongs to a different Backstory team. Ask your workspace admin, or sign in with the matching account.</p>
          </div>
        )}
        {peopleaiStatus === 'state-mismatch' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>The sign-in attempt expired. Start the connection again.</p>
          </div>
        )}
        {peopleaiStatus === 'connected' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Connected. You can head to your dashboard.</p>
          </div>
        )}
        {connected === '1' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Backstory MCP connected.</p>
          </div>
        )}
        {errorCode && oauthErrorCodes.has(errorCode) && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>The Backstory MCP connection didn&apos;t complete. Try again.</p>
          </div>
        )}

        <div className="mt-6 space-y-3">
          {/* Step 1 — Sales AI entitlement */}
          <div className="rounded-lg border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Step 1</p>
            <p className="mt-0.5 text-sm font-semibold text-gray-900">Sales AI entitlement</p>
            {status.entitled ? (
              <div className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700">
                <Check className="h-4 w-4 shrink-0" />
                Sales AI connected
              </div>
            ) : (
              <a
                href="/api/peopleai/connect?return_to=/connect"
                aria-disabled={status.loading}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Connect Backstory <ArrowRight className="h-4 w-4" />
              </a>
            )}
          </div>

          {/* Step 2 — Backstory MCP */}
          <div className="rounded-lg border p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Step 2</p>
            <div className="mt-0.5 flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900">Backstory MCP</p>
              <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium text-gray-500">
                OAuth 2.0
              </span>
            </div>
            {status.backstoryServerUrl && (
              <p className="mt-1 truncate text-xs text-gray-500" title={status.backstoryServerUrl}>
                {status.backstoryServerUrl}
              </p>
            )}
            {status.backstoryConnected ? (
              <div className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700">
                <Check className="h-4 w-4 shrink-0" />
                Backstory MCP connected
              </div>
            ) : (
              <a
                href={`/api/mcp-connections/oauth/start?connectionId=${status.backstoryConnectionId ?? ''}&returnTo=/connect`}
                aria-disabled={status.loading || !status.backstoryConnectionId}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Connect Backstory MCP <ArrowRight className="h-4 w-4" />
              </a>
            )}
          </div>
        </div>

        <p className="mt-4 text-xs leading-5 text-gray-400">
          You&apos;ll authenticate with Salesforce through Backstory. Backstory
          only receives tokens scoped to your permissions — no passwords.
        </p>
      </div>
    </main>
  )
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectInner />
    </Suspense>
  )
}
