'use client'

import { useState } from 'react'
import { CheckCircle2, Loader2, NotebookPen } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCachedJson } from '@/lib/client/use-cached-json'

type GranolaState = {
  configured: boolean
  source: 'org' | 'env' | null
}

export function GranolaCard() {
  // Cached (stale-while-revalidate): a revisit paints the last-seen status
  // instantly; mutations below update the cache via mutate().
  const { data: state, loading, mutate } = useCachedJson<GranolaState>('/api/integrations/granola')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'test' | 'save' | 'remove' | null>(null)

  const test = async () => {
    setBusy('test')
    try {
      const response = await fetch('/api/integrations/granola/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'The connection test failed')
      toast.success('Granola connection works')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The connection test failed')
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!apiKey.trim()) {
      toast.error('Paste your Granola API key first')
      return
    }
    setBusy('save')
    try {
      const response = await fetch('/api/integrations/granola', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save the key')
      mutate({ configured: data.configured, source: data.source })
      setApiKey('')
      toast.success('Granola connected')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save the key')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm('Remove the Granola API key for this workspace?')) return
    setBusy('remove')
    try {
      const response = await fetch('/api/integrations/granola', { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to remove the key')
      mutate({ configured: data.configured, source: data.source })
      toast.success('Granola key removed')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to remove the key')
    } finally {
      setBusy(null)
    }
  }

  const connected = Boolean(state?.configured)
  const hasOrgKey = state?.source === 'org'

  return (
    <Card>
      <CardHeader>
        <p className="eyebrow">Meeting notes</p>
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2"><NotebookPen className="h-4 w-4" />Granola</span>
          <Badge variant="outline">
            {loading
              ? 'Checking...'
              : connected
                ? <><CheckCircle2 className="mr-1 h-3 w-3 text-green-600" />Connected</>
                : 'Not connected'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-500">
          Paste your Granola API key so agents can read your meeting notes. Backstory stores the key
          encrypted and scoped to your workspace.
        </p>
        {state?.source === 'env' && (
          <p className="text-sm text-gray-500">
            Currently using the shared environment key. Save a workspace key to override it.
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="granola-api-key">API key</Label>
          <Input
            id="granola-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="grn_..."
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy !== null || !apiKey.trim()}>
            {busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save key
          </Button>
          <Button variant="outline" onClick={test} disabled={busy !== null || (!apiKey.trim() && !connected)}>
            {busy === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Test connection
          </Button>
          {hasOrgKey && (
            <Button variant="outline" onClick={remove} disabled={busy !== null}>
              {busy === 'remove' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
