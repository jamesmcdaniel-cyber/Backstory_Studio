'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { IntegrationLogo } from '@/components/integrations/integration-logo'

type Integration = {
  id: string
  provider: string
  name: string
  logo?: string
}

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
}

export function OAuthIntegrationsGrid() {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [connections, setConnections] = useState<Record<string, Connection>>({})
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>('loading')
  const connectUIRef = useRef<ConnectUI | null>(null)

  const load = useCallback(async () => {
    setBusy('loading')
    try {
      const [integrationsResponse, statusResponse] = await Promise.all([
        fetch('/api/nango/integrations', { cache: 'no-store' }),
        fetch('/api/nango/status', { cache: 'no-store' }),
      ])
      const integrationsData = await integrationsResponse.json()
      const statusData = await statusResponse.json()
      if (!integrationsResponse.ok) throw new Error(integrationsData.error || 'Unable to load available integrations')
      if (!statusResponse.ok) throw new Error(statusData.error || 'Unable to load connected accounts')
      setIntegrations(integrationsData.integrations || [])
      setConnections(statusData.connections || {})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to load integrations')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    load()
    return () => {
      connectUIRef.current?.close()
      connectUIRef.current = null
    }
  }, [load])

  const visibleIntegrations = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query
      ? integrations.filter((integration) => `${integration.name} ${integration.provider}`.toLowerCase().includes(query))
      : integrations
  }, [integrations, search])

  const connect = async (integration: Integration) => {
    setBusy(integration.id)
    try {
      const nango = new Nango()
      const connectBaseUrl = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
      const connectUI = nango.openConnectUI({
        ...(connectBaseUrl ? { baseURL: connectBaseUrl } : {}),
        onEvent: (event) => {
          if (event.type === 'connect') {
            toast.success(`${integration.name} connected`)
            connectUIRef.current = null
            setBusy(null)
            load()
          } else if (event.type === 'close') {
            connectUIRef.current = null
            setBusy(null)
          } else if (event.type === 'error') {
            toast.error(event.payload.errorMessage || 'Unable to connect account')
          }
        },
      })
      connectUIRef.current = connectUI

      const response = await fetch('/api/nango/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: integration.id }),
      })
      const data = await response.json()
      if (!response.ok || !data.sessionToken) {
        connectUI.close()
        connectUIRef.current = null
        throw new Error(data.error || 'Unable to start the connection flow')
      }
      connectUI.setSessionToken(data.sessionToken)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect account')
      setBusy(null)
    }
  }

  const disconnect = async (integration: Integration) => {
    if (!window.confirm(`Disconnect ${integration.name}?`)) return
    setBusy(integration.id)
    try {
      const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to disconnect account')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to disconnect account')
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search integrations" />
        <Button variant="outline" size="icon" onClick={load} disabled={busy === 'loading'}>
          <RefreshCw className={busy === 'loading' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {!visibleIntegrations.length && busy !== 'loading' && (
        <p className="text-sm text-gray-500">
          No integrations are enabled yet. Enable integrations in your Nango dashboard and they appear here.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleIntegrations.map((integration) => {
          const connection = connections[integration.id]
          return (
            <Card key={integration.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span className="flex items-center gap-2">
                    <IntegrationLogo src={integration.logo} slug={integration.provider} name={integration.name} />
                    {integration.name}
                  </span>
                  <Badge variant="outline">
                    {connection?.connected ? <><CheckCircle2 className="mr-1 h-3 w-3 text-green-600" />Connected</> : 'Not connected'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 min-h-10 text-sm text-gray-500">
                  Connect your {integration.name} account so agents can act on your behalf.
                </p>
                {connection?.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {connection?.connected
                  ? <Button className="w-full" variant="outline" onClick={() => disconnect(integration)} disabled={busy === integration.id}>Disconnect</Button>
                  : <Button className="w-full" onClick={() => connect(integration)} disabled={busy === integration.id}>
                      {busy === integration.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Connect
                    </Button>}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
