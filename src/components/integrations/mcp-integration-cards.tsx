'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, Plug } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Connection = {
  provider: string
  status: 'pending_auth' | 'active' | 'error' | 'not_connected'
  oauthUrl?: string
  toolCount?: number
  capabilities?: { description?: string; verbs?: string[] }
}

export function MCPIntegrationCards() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/mcp/connections', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to load Klavis connections')
      setConnections(data.connections || [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load Klavis connections')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const connect = async (provider: string) => {
    setConnecting(provider)
    setError('')
    try {
      const response = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [provider] }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Connection failed')
      const oauthUrl = data.results?.[0]?.oauthUrl
      if (oauthUrl) window.open(oauthUrl, '_blank', 'width=600,height=700')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Connection failed')
    } finally {
      setConnecting(null)
    }
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading Klavis connections...</div>

  return (
    <div className="space-y-4">
      {error && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="h-4 w-4" /> {error}</div>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connections.map((connection) => (
          <Card key={connection.provider}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base capitalize">
                <span className="flex items-center gap-2"><Plug className="h-4 w-4" />{connection.provider}</span>
                <Badge variant="outline">{connection.status.replace('_', ' ')}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-gray-500">{connection.capabilities?.description || 'Klavis MCP connection'}</p>
              {connection.status === 'active'
                ? <p>{connection.toolCount || 0} tools available</p>
                : <Button className="w-full" disabled={connecting === connection.provider} onClick={() => connect(connection.provider)}>
                    {connecting === connection.provider ? 'Connecting...' : 'Connect with Klavis'}
                  </Button>}
            </CardContent>
          </Card>
        ))}
      </div>
      {!connections.length && <p className="text-sm text-gray-500">No Klavis providers are configured.</p>}
    </div>
  )
}
