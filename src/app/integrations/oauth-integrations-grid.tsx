'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Plug, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type App = {
  id: string
  slug: string
  name: string
  description?: string
}

type Connection = {
  connected: boolean
  error?: string
  lastSync?: string
}

export function OAuthIntegrationsGrid() {
  const [apps, setApps] = useState<App[]>([])
  const [connections, setConnections] = useState<Record<string, Connection>>({})
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>('loading')

  const load = useCallback(async () => {
    setBusy('loading')
    try {
      const [appsResponse, statusResponse] = await Promise.all([
        fetch('/api/pipedream/apps?limit=60', { cache: 'no-store' }),
        fetch('/api/pipedream/status', { cache: 'no-store' }),
      ])
      const appsData = await appsResponse.json()
      const statusData = await statusResponse.json()
      if (!appsResponse.ok) throw new Error(appsData.error || 'Unable to load Pipedream apps')
      if (!statusResponse.ok) throw new Error(statusData.error || 'Unable to load Pipedream connections')
      setApps((appsData.apps || []).map((app: App) => ({ ...app, slug: app.slug || app.id })))
      setConnections(statusData.integrations || {})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to load integrations')
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const visibleApps = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query
      ? apps.filter((app) => `${app.name} ${app.description || ''}`.toLowerCase().includes(query))
      : apps
  }, [apps, search])

  const connect = async (app: App) => {
    setBusy(app.slug)
    try {
      const response = await fetch('/api/pipedream/connect-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appSlug: app.slug }),
      })
      const data = await response.json()
      if (!response.ok || !data.url) throw new Error(data.error || 'Unable to create connection link')
      window.location.href = data.url
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect integration')
      setBusy(null)
    }
  }

  const disconnect = async (app: App) => {
    if (!window.confirm(`Disconnect ${app.name}?`)) return
    setBusy(app.slug)
    try {
      const response = await fetch(`/api/pipedream/apps/${app.slug}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to disconnect integration')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to disconnect integration')
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Pipedream apps" />
        <Button variant="outline" size="icon" onClick={load} disabled={busy === 'loading'}>
          <RefreshCw className={busy === 'loading' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleApps.map((app) => {
          const connection = connections[app.slug]
          return (
            <Card key={app.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span className="flex items-center gap-2"><Plug className="h-4 w-4" />{app.name}</span>
                  <Badge variant="outline">
                    {connection?.connected ? <><CheckCircle2 className="mr-1 h-3 w-3 text-green-600" />Connected</> : 'Not connected'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 min-h-10 text-sm text-gray-500">{app.description || 'Connect this app through Pipedream.'}</p>
                {connection?.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {connection?.connected
                  ? <Button className="w-full" variant="outline" onClick={() => disconnect(app)} disabled={busy === app.slug}>Disconnect</Button>
                  : <Button className="w-full" onClick={() => connect(app)} disabled={busy === app.slug}>
                      {busy === app.slug && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Connect
                    </Button>}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
