'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUpRight, Loader2, Play, Plus, Radio, Sparkles, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/ui/markdown'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCachedJson } from '@/lib/client/use-cached-json'

const SIGNAL_TYPES = [
  'deal.score_updated',
  'deal.risk_detected',
  'deal.stage_changed',
  'forecast.updated',
  'insight.generated',
  'stakeholder.engagement_changed',
]

type Signal = {
  id: string
  type: string
  accountId: string | null
  opportunityId: string | null
  provenanceUrl: string | null
  receivedAt: string
  processedAt: string | null
  _count: { subscriptionRuns: number }
}

type Subscription = {
  id: string
  signalType: string
  isActive: boolean
  agentTask: { id: string; description: string | null } | null
}

type Agent = { id: string; title: string }

function SignalsList() {
  // Cached (stale-while-revalidate): a revisit paints the last-seen feed
  // instantly instead of a spinner, then refreshes in the background.
  const { data, loading } = useCachedJson<{ signals?: Signal[] }>('/api/signals?limit=100')
  const signals = data?.signals ?? []

  if (loading && !signals.length) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-10 rounded-xl" />
      </div>
    )
  }
  if (signals.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        title="No signals yet"
        description="When Backstory sends an event, it appears here."
      />
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Signal</TableHead>
          <TableHead>Entity</TableHead>
          <TableHead>Runs</TableHead>
          <TableHead>Received</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {signals.map((signal) => (
          <TableRow key={signal.id}>
            <TableCell><span className="mono-label">{signal.type}</span></TableCell>
            <TableCell className="text-gray-600">{signal.opportunityId || signal.accountId || '—'}</TableCell>
            <TableCell className="font-mono tabular-nums text-gray-600">{signal._count.subscriptionRuns}</TableCell>
            <TableCell className="font-mono text-xs tabular-nums text-gray-500">{new Date(signal.receivedAt).toLocaleString()}</TableCell>
            <TableCell className="text-right">
              {signal.provenanceUrl && (
                <a
                  href={signal.provenanceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-horizon-600 hover:underline"
                >
                  Backstory <ArrowUpRight className="h-3 w-3" />
                </a>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function SubscriptionsManager() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [signalType, setSignalType] = useState(SIGNAL_TYPES[1])
  const [agentId, setAgentId] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const [subResponse, agentResponse] = await Promise.all([
      fetch('/api/signal-subscriptions', { cache: 'no-store' }),
      fetch('/api/agents', { cache: 'no-store' }),
    ])
    if (subResponse.ok) setSubscriptions((await subResponse.json()).subscriptions || [])
    if (agentResponse.ok) setAgents((await agentResponse.json()).agents || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!agentId) {
      toast.error('Pick an agent to run.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/signal-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalType, agentTaskId: agentId }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not create the rule.')
        return
      }
      toast.success('Rule created.')
      setAgentId('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    const response = await fetch(`/api/signal-subscriptions/${id}`, { method: 'DELETE' })
    if (response.ok) {
      setSubscriptions((previous) => previous.filter((subscription) => subscription.id !== id))
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-12 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-white p-5 shadow-1">
        <p className="eyebrow">New rule</p>
        <h3 className="mt-1 font-semibold text-gray-900">When a signal arrives, run an agent</h3>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-500">When</span>
          <Select value={signalType} onValueChange={setSignalType}>
            <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SIGNAL_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-sm text-gray-500">run</span>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Select an agent" /></SelectTrigger>
            <SelectContent>
              {agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.title}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" loading={saving} onClick={create}>
            {!saving && <Plus className="h-4 w-4" />}
            Add rule
          </Button>
        </div>
      </div>

      {subscriptions.length === 0 ? (
        <EmptyState
          title="No routing rules yet"
          description="Add a rule above to run an agent whenever a signal arrives."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-white shadow-1">
          {subscriptions.map((subscription) => (
            <div key={subscription.id} className="flex items-center gap-3 border-b px-4 py-3 transition-colors duration-fast last:border-b-0 hover:bg-graphite-50/70">
              <span className="mono-label">{subscription.signalType}</span>
              <span className="text-sm text-gray-400">→</span>
              <span className="flex-1 text-sm text-gray-700">{subscription.agentTask?.description || 'agent'}</span>
              <Button variant="ghost" size="icon" onClick={() => remove(subscription.id)} aria-label="Delete rule">
                <Trash2 className="h-4 w-4 text-gray-400" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type CustomSignal = {
  id: string
  name: string
  question: string
  scope: 'account' | 'opportunity'
  updatedAt: string
}

// Rep-defined saved SalesAI questions ("custom signals"). Backstory exposes no
// signal catalog, so they're defined here and run via ask_sales_ai; results feed
// the graph so agents can use them.
function CustomSignalsManager() {
  const [signals, setSignals] = useState<CustomSignal[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const [scope, setScope] = useState<'account' | 'opportunity'>('account')
  const [saving, setSaving] = useState(false)
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [runningId, setRunningId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/signals/custom', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setSignals(data.success ? data.signals : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!name.trim() || !question.trim()) {
      toast.error('Give the signal a name and a question.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/signals/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, question, scope }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not save the signal.')
        return
      }
      setName(''); setQuestion(''); setScope('account')
      toast.success('Signal saved.')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    const response = await fetch(`/api/signals/custom?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (response.ok) setSignals((prev) => prev.filter((s) => s.id !== id))
  }

  const run = async (signal: CustomSignal) => {
    const target = (targets[signal.id] || '').trim()
    if (!target) {
      toast.error(signal.scope === 'account' ? 'Enter an account name or id.' : 'Enter an opportunity id.')
      return
    }
    setRunningId(signal.id)
    try {
      const response = await fetch(`/api/signals/custom/${signal.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not run the signal.')
        return
      }
      setResults((prev) => ({ ...prev, [signal.id]: data.answer }))
    } finally {
      setRunningId(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-white p-5 shadow-1">
        <p className="eyebrow">New custom signal</p>
        <h3 className="mt-1 font-semibold text-gray-900">A saved SalesAI question you can reuse</h3>
        <p className="mt-1 text-sm text-gray-500">
          e.g. &ldquo;Who&apos;s talking about us and what do they care about?&rdquo; or &ldquo;What&apos;s the next best action?&rdquo; — run it against any account or opportunity; results feed your agents.
        </p>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
            <Input placeholder="Signal name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={scope} onValueChange={(v) => setScope(v as 'account' | 'opportunity')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="account">Account</SelectItem>
                <SelectItem value="opportunity">Opportunity</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea rows={3} placeholder="The question SalesAI should answer…" value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Button size="sm" loading={saving} onClick={create}>
            {!saving && <Plus className="h-4 w-4" />}
            Save signal
          </Button>
        </div>
      </div>

      {signals.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No custom signals yet"
          description="Save one above to reuse it across accounts."
        />
      ) : (
        <div className="stagger-children space-y-4">
          {signals.map((signal) => (
            <div key={signal.id} className="rounded-xl border bg-white p-4 shadow-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{signal.name}</span>
                    <Badge variant="info" className="rounded-full text-[10px] uppercase tracking-wide">{signal.scope}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">{signal.question}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(signal.id)} aria-label="Delete signal">
                  <Trash2 className="h-4 w-4 text-gray-400" />
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  className="h-9 w-64"
                  placeholder={signal.scope === 'account' ? 'Account name or id' : 'Opportunity id'}
                  value={targets[signal.id] || ''}
                  onChange={(e) => setTargets((prev) => ({ ...prev, [signal.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && run(signal)}
                />
                <Button size="sm" variant="outline" disabled={runningId === signal.id} onClick={() => run(signal)}>
                  {runningId === signal.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                  Run
                </Button>
              </div>
              {results[signal.id] && (
                <div className="mt-3 animate-fade-in rounded-lg border bg-gray-50 p-3 text-sm">
                  <Markdown>{results[signal.id]}</Markdown>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SignalsPage() {
  return (
    <>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Sales AI"
          title="Signals"
          description="Backstory Sales AI events, your custom signals, and the agents they trigger."
        />
        <Tabs defaultValue="feed">
          <TabsList>
            <TabsTrigger value="feed">Signal feed</TabsTrigger>
            <TabsTrigger value="custom">Custom signals</TabsTrigger>
            <TabsTrigger value="rules">Routing rules</TabsTrigger>
          </TabsList>
          <TabsContent value="feed" className="mt-6"><SignalsList /></TabsContent>
          <TabsContent value="custom" className="mt-6"><CustomSignalsManager /></TabsContent>
          <TabsContent value="rules" className="mt-6"><SubscriptionsManager /></TabsContent>
        </Tabs>
      </div>
    </>
  )
}
