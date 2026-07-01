'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, ChevronDown, CircleDashed, FileText, HelpCircle, Loader2, Plus, Send, Sparkles, Wrench, X } from 'lucide-react'
import { AgentConfigDialog } from './agent-config-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { AGENTS_CHANGED_EVENT, notifyAgentsChanged } from '@/components/layout/sidebar'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

import type { Agent, Activity } from '@/lib/types'

type RunStep = {
  id: string
  node: string
  status: string
  input?: any
  output?: any
  error?: any
  startedAt?: string | null
  completedAt?: string | null
}
type RunDetails = {
  execution: Activity
  steps: RunStep[]
  events: Array<{ id: string; kind: string; payload?: any; ts: string }>
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>
}

type GranolaNote = {
  id: string
  title: string
  owner: { name: string; email: string } | null
  created_at: string | null
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

function stepDuration(step: RunStep): string | null {
  if (!step.startedAt || !step.completedAt) return null
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function asJson(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

// One tool call: header always visible; inputs/outputs expand on click so a
// successful call's data is inspectable, not hidden behind a bare status badge.
function ToolCallCard({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false)
  const duration = stepDuration(step)
  const failed = step.status === 'failed'
  const input = asJson(step.input)
  const output = asJson(step.error ?? step.output)
  const hasDetail = Boolean(input || output)
  return (
    <div className="rounded-lg border text-sm">
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2">
          {hasDetail && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />}
          <span className="truncate font-mono text-xs">{step.node}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {duration && <span className="text-xs text-gray-500">{duration}</span>}
          <Badge variant="outline" className={failed ? 'border-red-200 text-red-600' : undefined}>{step.status}</Badge>
        </span>
      </button>
      {open && hasDetail && (
        <div className="space-y-2 border-t px-3 py-2">
          {input && (
            <div>
              <p className="mono-label mb-1">Input</p>
              <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs">{input}</pre>
            </div>
          )}
          {output && (
            <div>
              <p className="mono-label mb-1">{failed ? 'Error' : 'Output'}</p>
              <pre className={`overflow-x-auto rounded p-2 text-xs ${failed ? 'bg-red-50 text-red-700' : 'bg-gray-50'}`}>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
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
  const [granolaPickerOpen, setGranolaPickerOpen] = useState(false)
  const [granolaFetchingList, setGranolaFetchingList] = useState(false)
  const [granolaFetchingNote, setGranolaFetchingNote] = useState(false)
  const [granolaNotes, setGranolaNotes] = useState<GranolaNote[]>([])
  const granolaPickerRef = useRef<HTMLDivElement>(null)

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

  // Escape closes the Granola meeting picker (keyboard parity with the close button).
  useEffect(() => {
    if (!granolaPickerOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setGranolaPickerOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [granolaPickerOpen])

  useEffect(() => {
    if (!selectedRun) {
      setRunDetails(null)
      return
    }
    let cancelled = false
    const fetchDetails = () =>
      fetch(`/api/workflows/executions?executionId=${selectedRun.id}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => { if (!cancelled) setRunDetails(data.items?.[0] || null) })
        .catch(() => { if (!cancelled) setRunDetails(null) })
    fetchDetails()
    // While a run is active, poll its detail so tool calls and output stream in
    // without a full-page refetch.
    const isActive = ['running', 'pending', 'waiting_for_input'].includes(activityStatus(selectedRun))
    const timer = isActive ? window.setInterval(fetchDetails, 2500) : undefined
    return () => { cancelled = true; if (timer) window.clearInterval(timer) }
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
      toast.success(`Created "${data.draft?.title || 'agent'}".`)
      await load()
    } finally {
      setBuilding(false)
    }
  }

  const openGranolaPicker = async () => {
    setGranolaFetchingList(true)
    setGranolaNotes([])
    try {
      const response = await fetch('/api/granola/notes')
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Granola not connected')
        return
      }
      setGranolaNotes(data.notes || [])
      setGranolaPickerOpen(true)
    } catch {
      toast.error('Could not reach Granola. Please try again.')
    } finally {
      setGranolaFetchingList(false)
    }
  }

  const importGranolaNote = async (note: GranolaNote) => {
    setGranolaFetchingNote(true)
    try {
      const response = await fetch(`/api/granola/notes/${encodeURIComponent(note.id)}`)
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Could not load that meeting note.')
        return
      }
      const { title, summary } = data.note as { id: string; title: string; summary: string }
      const prefill = `Build an agent based on this meeting. Identify the workflow or task that was requested and create an agent that carries it out.\n\nMeeting: ${title}\n\n${summary}`
      setDescribe(prefill.slice(0, 3800))
      setGranolaPickerOpen(false)
    } catch {
      toast.error('Could not load that meeting note. Please try again.')
    } finally {
      setGranolaFetchingNote(false)
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
                <p className="truncate text-sm text-gray-500" aria-live="polite">Hey, {user?.firstName || 'there'}. {greeting}</p>
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
                placeholder={"Describe an agent to build — e.g. “Every Monday, summarize last week’s GitHub activity and post it to Slack”"}
                value={describe}
                disabled={building}
                onChange={(event) => setDescribe(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && buildFromDescription()}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={granolaFetchingList || building}
                onClick={openGranolaPicker}
                title="Import from Granola"
                className="shrink-0 gap-1.5 text-xs text-gray-500 hover:text-gray-700"
              >
                {granolaFetchingList ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                Import
              </Button>
              <Button size="sm" disabled={building || !describe.trim()} onClick={buildFromDescription}>
                {building ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Build'}
              </Button>
            </div>
            {/* Granola meeting picker */}
            {granolaPickerOpen && (
              <div
                ref={granolaPickerRef}
                className="relative mt-1 max-h-64 overflow-y-auto rounded-xl border bg-white shadow-lg"
              >
                <div className="sticky top-0 flex items-center justify-between border-b bg-white px-3 py-2">
                  <span className="text-xs font-medium text-gray-600">Select a meeting to import</span>
                  <button
                    className="rounded p-0.5 text-gray-400 hover:text-gray-700"
                    onClick={() => setGranolaPickerOpen(false)}
                    aria-label="Close picker"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {granolaFetchingNote && (
                  <div className="flex items-center justify-center p-6 text-sm text-gray-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading meeting…
                  </div>
                )}
                {!granolaFetchingNote && granolaNotes.length === 0 && (
                  <p className="p-4 text-sm text-gray-500">No recent meetings found in Granola.</p>
                )}
                {!granolaFetchingNote && granolaNotes.map((note) => (
                  <button
                    key={note.id}
                    className="flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-gray-50"
                    onClick={() => importGranolaNote(note)}
                  >
                    <span className="truncate text-sm font-medium">{note.title}</span>
                    <span className="truncate text-xs text-gray-400">
                      {note.owner?.name || note.owner?.email || ''}
                      {note.owner && note.created_at ? ' · ' : ''}
                      {note.created_at ? new Date(note.created_at).toLocaleDateString() : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
                  <h3 className="eyebrow mb-2">Output</h3>
                  {resultText(selectedRun)
                    ? <div className="rounded-lg border bg-gray-50 p-4"><Markdown>{resultText(selectedRun)}</Markdown></div>
                    : <p className="flex items-center gap-2 rounded-lg border bg-gray-50 p-4 text-sm text-gray-500">
                        {activityStatus(selectedRun) === 'running' && <Loader2 className="h-4 w-4 animate-spin" />}
                        {activityStatus(selectedRun) === 'running' ? 'Agent is working…' : 'No output yet.'}
                      </p>}
                </div>
                <div>
                  <h3 className="eyebrow mb-2 flex items-center gap-2"><Wrench className="h-4 w-4" /> Tool calls {runDetails?.steps?.length ? `· ${runDetails.steps.length}` : ''}</h3>
                  <div className="space-y-2">
                    {runDetails?.steps?.map((step) => (
                      <ToolCallCard key={step.id} step={step} />
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
