'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, CircleDashed, HelpCircle, Loader2, Plus, Send, Sparkles, Wrench } from 'lucide-react'
import { AgentConfigDialog } from './agent-config-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { AGENTS_CHANGED_EVENT, notifyAgentsChanged } from '@/components/layout/sidebar'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

type Agent = {
  id: string
  title: string
  description: string
  instructions: string
  model: string
  integrations: string[]
  icon: string
  folder: string | null
  visibility: 'shared' | 'private'
  status: string
  priority: string
  schedule: { type: string; isActive: boolean }
}

type Activity = {
  id: string
  agentTaskId?: string | null
  agentType: string
  status: string
  input: any
  output?: any
  error?: string | null
  metadata?: any
  startedAt: string
  completedAt?: string | null
}

type RunDetails = {
  execution: Activity
  steps: Array<{ id: string; node: string; status: string; output?: any; error?: any }>
  events: Array<{ id: string; kind: string; payload?: any; ts: string }>
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>
}

const groupOrder = ['running', 'waiting_for_input', 'failed', 'completed'] as const

const groupLabels: Record<string, string> = {
  running: 'Running',
  waiting_for_input: 'Needs input',
  failed: 'Error',
  completed: 'Success',
}

function activityStatus(activity: Activity) {
  return activity.status.toLowerCase()
}

function statusLabel(status: string) {
  return groupLabels[status] || status
}

function resultText(activity?: Activity | null) {
  if (!activity) return ''
  if (activity.error) return activity.error
  const value = activity.output?.summary ?? activity.output?.response ?? activity.output
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function AgentHQ() {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [agents, setAgents] = useState<Agent[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [selectedRun, setSelectedRun] = useState<Activity | null>(null)
  const [runDetails, setRunDetails] = useState<RunDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAgentDialog, setShowAgentDialog] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [asking, setAsking] = useState(false)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [describe, setDescribe] = useState('')
  const [building, setBuilding] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [agentResponse, activityResponse] = await Promise.all([
      fetch('/api/agents', { cache: 'no-store' }),
      fetch('/api/agents/activity?limit=100', { cache: 'no-store' }),
    ])
    if (agentResponse.ok) {
      const data = await agentResponse.json()
      setAgents(data.agents || [])
      setAuthError(null)
      setAuthStatus(null)
    } else {
      // Surface the real reason instead of rendering an empty shell.
      const data = await agentResponse.json().catch(() => ({}))
      setAuthStatus(agentResponse.status)
      setAuthError(data.error || `Couldn't load agents (HTTP ${agentResponse.status}).`)
    }
    if (activityResponse.ok) {
      const data = await activityResponse.json()
      setActivities(data.activities || [])
      setSelectedRun((current) => current
        ? data.activities?.find((activity: Activity) => activity.id === current.id) || current
        : data.activities?.[0] || null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load().catch(() => setLoading(false))
    const interval = window.setInterval(() => load().catch(() => undefined), 10000)
    const onChanged = () => load().catch(() => undefined)
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged)
    }
  }, [load])

  // Deep links from the command palette and sidebar: ?agent=<id|new>, ?run=<id>.
  useEffect(() => {
    const agentParam = searchParams.get('agent')
    if (!agentParam) return
    if (agentParam === 'new') {
      setEditingAgent(null)
      setShowAgentDialog(true)
      router.replace('/dashboard')
      return
    }
    if (!agents.length) return
    const agent = agents.find((candidate) => candidate.id === agentParam)
    if (agent) {
      setEditingAgent(agent)
      setShowAgentDialog(true)
    }
    router.replace('/dashboard')
  }, [searchParams, agents, router])

  useEffect(() => {
    const runParam = searchParams.get('run')
    if (!runParam || loading) return
    const activity = activities.find((candidate) => candidate.id === runParam)
    if (activity) {
      setSelectedRun(activity)
      router.replace('/dashboard')
      return
    }
    fetch(`/api/workflows/executions?executionId=${runParam}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        const execution = data.items?.[0]?.execution
        if (execution) setSelectedRun(execution)
      })
      .catch(() => undefined)
      .finally(() => router.replace('/dashboard'))
  }, [searchParams, activities, loading, router])

  useEffect(() => {
    if (!selectedRun) {
      setRunDetails(null)
      return
    }
    fetch(`/api/workflows/executions?executionId=${selectedRun.id}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setRunDetails(data.items?.[0] || null))
      .catch(() => setRunDetails(null))
  }, [selectedRun])

  const grouped = useMemo(() => Object.fromEntries(groupOrder.map((status) => [
    status,
    activities.filter((activity) => activityStatus(activity) === status),
  ])) as Record<(typeof groupOrder)[number], Activity[]>, [activities])

  const greeting = useMemo(() => {
    const parts: string[] = []
    if (grouped.completed.length) parts.push(`${grouped.completed.length} completed`)
    if (grouped.waiting_for_input.length) parts.push(`${grouped.waiting_for_input.length} need your input`)
    if (grouped.failed.length) parts.push(`${grouped.failed.length} hit errors`)
    if (grouped.running.length) parts.push(`${grouped.running.length} running`)
    return parts.length ? `${parts.join(', ')}.` : 'No agent runs yet.'
  }, [grouped])

  const saveAgent = async (draft: any) => {
    const response = await fetch('/api/agents', {
      method: editingAgent ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingAgent ? { ...draft, id: editingAgent.id } : draft),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data.error || `Failed to save agent (HTTP ${response.status}).`
      toast.error(message)
      throw new Error(message)
    }
    setEditingAgent(null)
    notifyAgentsChanged()
    toast.success(editingAgent ? 'Agent updated.' : 'Agent created.')
    await load()
  }

  const buildFromDescription = async () => {
    if (!describe.trim()) return
    setBuilding(true)
    try {
      const response = await fetch('/api/agents/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: describe, create: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || `Couldn't build the agent (HTTP ${response.status}).`)
        return
      }
      setDescribe('')
      notifyAgentsChanged()
      toast.success(`Created “${data.draft?.title || 'agent'}”.`)
      await load()
    } finally {
      setBuilding(false)
    }
  }

  const runAgent = async (agent: Agent) => {
    setRunningId(agent.id)
    try {
      const res = await fetch(`/api/agents/${agent.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (data.result?.status === 'waiting_for_input') {
          toast(`${agent.title} needs your input`)
        } else {
          toast.success(`${agent.title} ran`)
        }
        const newExecutionId: string | undefined = data.executionId
        // Refresh activities; load() updates the activities state internally and
        // already selects the first item — override to open the new execution.
        await load()
        if (newExecutionId) {
          setActivities((prev) => {
            const found = prev.find((a) => a.id === newExecutionId)
            if (found) setSelectedRun(found)
            return prev
          })
        }
      } else {
        toast.error(data.error || 'Run failed')
      }
    } finally {
      setRunningId(null)
    }
  }

  const sendReply = async () => {
    if (!selectedRun || !reply.trim()) return
    setReplying(true)
    try {
      await fetch(`/api/executions/${selectedRun.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: reply }),
      })
      setReply('')
      await load()
    } finally {
      setReplying(false)
    }
  }

  const ask = async () => {
    if (!selectedRun || !question.trim()) return
    setAsking(true)
    setAnswer('')
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionId: selectedRun.id, question }),
      })
      const data = await response.json()
      setAnswer(data.answer || data.error || 'No answer returned')
    } finally {
      setAsking(false)
    }
  }

  return (
    <DashboardLayout fullscreen>
      <div className="grid h-screen grid-cols-[minmax(420px,1fr)_minmax(440px,1.15fr)] overflow-hidden">
        <section className="overflow-y-auto border-r bg-white">
          <div className="sticky top-0 z-10 border-b bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold">Activity</h1>
                <p className="truncate text-sm text-gray-500">Hey, {user?.firstName || 'there'}. {greeting}</p>
              </div>
              <Button variant="outline" onClick={() => { setEditingAgent(null); setShowAgentDialog(true) }}>
                <Plus className="mr-1.5 h-4 w-4" /> New agent
              </Button>
            </div>
            {/* Den-style: describe an agent in plain language and build it. */}
            <div className="mt-3 flex items-center gap-2 rounded-xl border bg-gray-50 px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-200">
              <Sparkles className="h-4 w-4 shrink-0 text-indigo-500" />
              <input
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
                placeholder="Describe an agent to build — e.g. “Every Monday, summarize last week's GitHub activity and post it to Slack”"
                value={describe}
                disabled={building}
                onChange={(event) => setDescribe(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && buildFromDescription()}
              />
              <Button size="sm" disabled={building || !describe.trim()} onClick={buildFromDescription}>
                {building ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Build'}
              </Button>
            </div>
          </div>
          {authError && (
            <div className="m-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {authStatus === 401 ? (
                  <>
                    <p className="font-medium">You’re not signed in.</p>
                    <p className="mb-2 text-amber-800">This environment has no active session — sign in to load your workspace.</p>
                    <Button size="sm" onClick={() => router.push('/auth/login')}>Sign in</Button>
                  </>
                ) : authStatus === 403 ? (
                  <>
                    <p className="font-medium">Your workspace is still provisioning.</p>
                    <p className="text-amber-800">Reload in a moment. If this persists, the database isn’t reachable for this environment.</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">{authError}</p>
                    <p className="text-amber-800">The database or auth isn’t configured for this environment.</p>
                  </>
                )}
              </div>
            </div>
          )}
          {loading && <div className="p-8 text-center text-gray-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>}
          {!loading && activities.length === 0 && (
            <div className="p-8 text-center text-sm text-gray-500">
              {agents.length === 0 ? 'Create an agent or start from a template.' : 'Run an agent from the sidebar to see activity here.'}
            </div>
          )}
          {groupOrder.map((status) => {
            const items = grouped[status]
            if (!items.length) return null
            return (
              <div key={status}>
                <div className="flex items-center gap-2 border-b bg-gray-50 px-4 py-2 text-sm font-medium">
                  {status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                    status === 'running' ? <CircleDashed className="h-4 w-4 animate-spin text-blue-600" /> :
                    status === 'waiting_for_input' ? <HelpCircle className="h-4 w-4 text-amber-500" /> :
                    <AlertCircle className="h-4 w-4 text-red-600" />}
                  {groupLabels[status]} <span className="text-gray-400">{items.length}</span>
                </div>
                {items.map((activity) => (
                  <button
                    key={activity.id}
                    className={cn('grid w-full grid-cols-[1fr_auto] gap-3 border-b px-4 py-3 text-left hover:bg-gray-50', selectedRun?.id === activity.id && 'bg-indigo-50')}
                    onClick={() => { setSelectedRun(activity); setAnswer('') }}
                  >
                    <div>
                      <div className="text-sm font-medium">{activity.metadata?.title || activity.agentType}</div>
                      <div className="line-clamp-1 text-xs text-gray-500">{activity.metadata?.pendingQuestion?.question || activity.metadata?.headline || activity.error || resultText(activity) || 'In progress'}</div>
                    </div>
                    <time className="text-xs text-gray-400">{new Date(activity.startedAt).toLocaleString()}</time>
                  </button>
                ))}
              </div>
            )
          })}
        </section>

        <section className="flex min-w-0 flex-col bg-white">
          {selectedRun ? (
            <>
              <div className="border-b p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="truncate font-semibold">{selectedRun.metadata?.title || selectedRun.agentType}</h2>
                  <Badge variant="outline">{statusLabel(activityStatus(selectedRun))}</Badge>
                </div>
              </div>
              <div className="flex-1 space-y-5 overflow-y-auto p-5">
                {selectedRun.error && <pre className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{selectedRun.error}</pre>}
                {activityStatus(selectedRun) === 'waiting_for_input' && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-900"><HelpCircle className="h-4 w-4" /> Agent needs your input</h3>
                    <p className="mb-3 whitespace-pre-wrap text-sm text-amber-900">{selectedRun.metadata?.pendingQuestion?.question || 'The agent asked a question.'}</p>
                    <div className="flex gap-2">
                      <Input
                        value={reply}
                        onChange={(event) => setReply(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && sendReply()}
                        placeholder="Reply to the agent..."
                      />
                      <Button size="icon" disabled={replying || !reply.trim()} onClick={sendReply}>
                        {replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                )}
                {(runDetails?.messages?.length ?? 0) > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Conversation</h3>
                    <div className="space-y-2">
                      {(runDetails?.messages ?? []).map((message) => (
                        <div
                          key={message.id}
                          className={cn(
                            'whitespace-pre-wrap rounded-lg p-3 text-sm',
                            message.role === 'user' ? 'ml-8 bg-indigo-50' : 'mr-8 border bg-gray-50',
                          )}
                        >
                          {message.content}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Output</h3>
                  <pre className="whitespace-pre-wrap rounded-lg border bg-gray-50 p-4 text-sm leading-6">{resultText(selectedRun) || 'Agent is still running.'}</pre>
                </div>
                <div>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4" /> Tool calls</h3>
                  <div className="space-y-2">
                    {runDetails?.steps?.map((step) => (
                      <div key={step.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex justify-between gap-3"><span className="font-medium">{step.node}</span><Badge variant="outline">{step.status}</Badge></div>
                        {step.error && <pre className="mt-2 whitespace-pre-wrap text-xs text-red-600">{JSON.stringify(step.error, null, 2)}</pre>}
                      </div>
                    ))}
                    {!runDetails?.steps?.length && <p className="text-sm text-gray-500">No tool calls recorded.</p>}
                  </div>
                </div>
              </div>
              <div className="border-t p-4">
                {answer && <div className="mb-3 whitespace-pre-wrap rounded-lg bg-indigo-50 p-3 text-sm">{answer}</div>}
                <div className="flex gap-2">
                  <Input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && ask()} placeholder="Ask about this output..." />
                  <Button size="icon" disabled={asking || !question.trim()} onClick={ask}>
                    {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="m-auto text-sm text-gray-500">Run an agent to review its output.</div>
          )}
        </section>
      </div>

      <AgentConfigDialog
        open={showAgentDialog}
        onOpenChange={setShowAgentDialog}
        onCreateAgent={saveAgent}
        onRunAgent={editingAgent ? runAgent : undefined}
        editingAgent={editingAgent}
        runningId={runningId}
      />
    </DashboardLayout>
  )
}

export default function AgentHQPage() {
  return (
    <Suspense fallback={null}>
      <AgentHQ />
    </Suspense>
  )
}
