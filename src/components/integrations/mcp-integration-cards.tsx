'use client'

import { useState } from 'react'
import { AlertCircle, ChevronDown, Loader2, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'

type Tool = { name: string; description?: string }

type Connection = {
  provider: string
  status: 'pending_auth' | 'active' | 'error' | 'not_connected'
  oauthUrl?: string
  toolCount?: number
  capabilities?: { description?: string; verbs?: string[] }
  tools?: Tool[]
}

function toolLabel(name: string) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function MCPIntegrationCards() {
  // Cached (stale-while-revalidate): a revisit paints instantly from the client
  // cache, then revalidates — no flash. The server also caches the Klavis status
  // per org, so the revalidation itself is fast.
  const { data, loading, error: loadError, refresh } = useCachedJson<{ connections?: Connection[] }>('/api/mcp/connections')
  const connections = data?.connections ?? []
  const [connecting, setConnecting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const connect = async (provider: string) => {
    setConnecting(provider)
    setActionError('')
    try {
      const response = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [provider] }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Connection failed')
      const oauthUrl = result.results?.[0]?.oauthUrl
      if (oauthUrl) {
        const popup = window.open(oauthUrl, '_blank', 'width=600,height=700')
        if (!popup) setActionError('Your browser blocked the sign-in popup — allow popups for this site and click Connect again.')
      } else {
        // Klavis returns no OAuth URL for providers that aren't OAuth-based
        // (e.g. Snowflake uses account credentials) or are routed through Strata.
        // There's no popup to show — the user finishes auth in Klavis directly.
        const name = provider.charAt(0).toUpperCase() + provider.slice(1)
        setActionError(`${name} doesn't use a Klavis sign-in popup — finish authenticating it in your Klavis dashboard (for example, Snowflake needs account credentials). It will then show as connected here.`)
      }
      await refresh() // server cache is busted on connect; pull the fresh status
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Connection failed')
    } finally {
      setConnecting(null)
    }
  }

  const error = actionError || (loadError ? (loadError instanceof Error ? loadError.message : 'Failed to load Klavis connections') : '')

  // Only block on the spinner when there's no cached data to show yet.
  if (loading && !connections.length) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading Klavis connections...</div>

  return (
    <div className="space-y-4">
      {error && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="h-4 w-4" /> {error}</div>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connections.map((connection) => {
          const isOpen = expanded === connection.provider
          const tools = connection.tools ?? []
          const isActive = connection.status === 'active'
          return (
            <Card key={connection.provider}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base capitalize">
                  <span className="flex items-center gap-2">
                    <IntegrationLogo slug={connection.provider} name={connection.provider} />
                    {connection.provider}
                  </span>
                  <Badge variant="outline">{connection.status.replace('_', ' ')}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-gray-500">{connection.capabilities?.description || 'Klavis MCP connection'}</p>

                {tools.length > 0 && (
                  <div className="rounded-lg border">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : connection.provider)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-50"
                    >
                      <span className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5" /> {tools.length} {tools.length === 1 ? 'tool' : 'tools'}{isActive ? '' : ' available'}</span>
                      <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOpen && (
                      <ul className="space-y-2 border-t px-3 py-2">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <p className="font-medium text-gray-800">{toolLabel(tool.name)}</p>
                            {tool.description && <p className="text-xs text-gray-500">{tool.description}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {!isActive && (
                  <Button className="w-full" disabled={connecting === connection.provider} onClick={() => connect(connection.provider)}>
                    {connecting === connection.provider ? 'Connecting...' : 'Connect with Klavis'}
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
      {!connections.length && <p className="text-sm text-gray-500">No Klavis providers are configured.</p>}
    </div>
  )
}
