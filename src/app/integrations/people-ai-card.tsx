'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRight, Check, Loader2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Status = {
  configured: boolean
  connection: { status: string; teamId: string | null; membershipId: string | null } | null
  organization: { peopleAiTeamId: string | null; entitlementStatus: string }
}

/**
 * People.ai Sales AI connection card. Connecting runs the MCP OAuth flow
 * (Salesforce identity via People.ai); the connection powers the entitlement
 * gate and gives this user's agents their People.ai read tools.
 */
export function PeopleAiCard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/peopleai/status', { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (response.ok && data?.success) setStatus(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      const response = await fetch('/api/peopleai/connect', { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not disconnect People.ai.')
        return
      }
      toast.success('People.ai disconnected.')
      await load()
    } finally {
      setDisconnecting(false)
    }
  }

  const connected = status?.connection?.status === 'active'

  return (
    <div className="rounded-xl border bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Sales AI</p>
          <h3 className="mt-1 font-semibold text-gray-900">People.ai</h3>
          <p className="mt-1 text-sm text-gray-500">
            Read accounts, opportunities, activity, and Sales AI insights with
            your own People.ai permissions.
          </p>
        </div>
        {connected && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
            <Check className="h-3 w-3" /> Connected
          </span>
        )}
      </div>

      {loading ? (
        <div className="mt-4 text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : connected ? (
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-gray-400">
            Team {status?.connection?.teamId || status?.organization.peopleAiTeamId || '—'}
          </p>
          <Button variant="outline" size="sm" disabled={disconnecting} onClick={disconnect}>
            {disconnecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Unplug className="mr-1.5 h-3.5 w-3.5" />}
            Disconnect
          </Button>
        </div>
      ) : status?.configured ? (
        <div className="mt-4">
          <Button asChild size="sm">
            <a href="/api/peopleai/connect?return_to=/integrations">
              Connect People.ai <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
          {status.connection?.status === 'refresh_failed' && (
            <p className="mt-2 text-xs text-amber-700">
              Your previous connection expired — reconnect to restore access.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-xs text-gray-400">
          People.ai OAuth isn&apos;t configured for this environment.
        </p>
      )}
    </div>
  )
}
