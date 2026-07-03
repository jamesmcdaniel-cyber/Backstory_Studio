'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUpRight, Loader2, Play, Plus, Radio, Sparkles, Trash2 } from 'lucide-react'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/ui/markdown'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
  const [signals, setSignals] = useState<Signal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/signals?limit=100', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setSignals(data.signals || []))
      .catch(() => setSignals([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-8 text-center text-gray-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  if (signals.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <Radio className="mx-auto h-6 w-6 text-gray-300" />
        <p className="mt-2 text-sm text-gray-500">No signals yet. When People.ai sends an event, it appears here.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="px-4 py-2.5 font-medium text-gray-600">Signal</th>
            <th className="px-4 py-2.5 font-medium text-gray-600">Entity</th>
            <th className="px-4 py-2.5 font-medium text-gray-600">Runs</th>
            <th className="px-4 py-2.5 font-medium text-gray-600">Received</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {signals.map((signal) => (
            <tr key={signal.id} className="border-b last:border-b-0">
              <td className="px-4 py-2.5"><span className="mono-label">{signal.type}</span></td>
              <td className="px-4 py-2.5 text-gray-600">{signal.opportunityId || signal.accountId || '—'}</td>
              <td className="px-4 py-2.5 text-gray-600">{signal._count.subscriptionRuns}</td>
              <td className="px-4 py-2.5 text-gray-500">{new Date(signal.receivedAt).toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right">
                {signal.provenanceUrl && (
                  <a
                    href={signal.provenanceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-horizon-600 hover:underline"
                  >
                    People.ai <ArrowUpRight className="h-3 w-3" />
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

  if (loading) return <div className="p-8 text-center text-gray-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-white p-5">
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
          <Button size="sm" disabled={saving} onClick={create}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Add rule
          </Button>
        </div>
      </div>

      {subscriptions.length === 0 ? (
        <p className="text-sm text-gray-500">No routing rules yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-white">
          {subscriptions.map((subscription) => (
            <div key={subscription.id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
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

// Rep-defined saved SalesAI questions ("custom signals"). People.ai exposes no
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

  if (loading) return <div className="p-8 text-center text-gray-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-white p-5">
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
          <Button size="sm" disabled={saving} onClick={create}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Save signal
          </Button>
        </div>
      </div>

      {signals.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-gray-300" />
          <p className="mt-2 text-sm text-gray-500">No custom signals yet. Save one above to reuse it across accounts.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {signals.map((signal) => (
            <div key={signal.id} className="rounded-xl border bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{signal.name}</span>
                    <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">{signal.scope}</span>
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
                <div className="mt-3 rounded-lg border bg-gray-50 p-3 text-sm">
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
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Signals</h1>
          <p className="text-sm text-gray-500">People.ai Sales AI events, your custom signals, and the agents they trigger.</p>
        </div>
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
    </DashboardLayout>
  )
}
