'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { emptyGraph, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { insertAgentAfter, updateNode, deleteNode, changeNodeType } from '@/lib/flows/mutate'
import { FlowCanvas } from '@/components/flows/flow-canvas'
import { StepDrawer } from '@/components/flows/step-drawer'
import { CopilotPanel } from '@/components/flows/copilot-panel'
import { RunPanel, type FlowRunDetail } from '@/components/flows/run-panel'
import type { StepStatus } from '@/components/flows/step-card'

type Agent = { id: string; title: string }

/** Ordered main-chain ids from the trigger, for upstream-token help. */
function spineIds(graph: FlowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const nextId = (node: FlowNode): string | undefined => {
    const edges = graph.edges.filter((e) => e.source === node.id)
    return (node.type === 'condition' ? edges.find((e) => e.branch === 'true') ?? edges[0] : edges[0])?.target
  }
  const ids: string[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    const next = nextId(current)
    current = next ? byId.get(next) : undefined
  }
  return ids
}

export default function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [name, setName] = useState('')
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  const [status, setStatus] = useState('draft')
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<'build' | 'test'>('build')
  const [showCopilot, setShowCopilot] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusByNode, setStatusByNode] = useState<Record<string, StepStatus>>({})
  const [testInput, setTestInput] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt?: string }[]>([])
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/flows', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([flowsData, agentsData]) => {
        if (cancelled) return
        const flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        if (flow) {
          setName(flow.name)
          setGraph(flow.graph && flow.graph.nodes ? flow.graph : emptyGraph())
          setStatus(flow.status)
        }
        setAgents(agentsData.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents])
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null
  const insideLoop = useMemo(
    () => graph.nodes.some((n) => n.type === 'loop' && n.data.body.includes(selectedId ?? '')),
    [graph, selectedId],
  )
  const upstreamIds = useMemo(() => {
    const ids = spineIds(graph)
    const idx = ids.indexOf(selectedId ?? '')
    return (idx > 0 ? ids.slice(1, idx) : ids.slice(1)).filter((x) => x !== selectedId)
  }, [graph, selectedId])

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, graph, status: status.toUpperCase() }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not save the flow.')
        return false
      }
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, graph, status])

  const pollRuns = useCallback(() => {
    const tick = async () => {
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      if (data?.runs) setRuns(data.runs.map((r: { id: string; status: string; startedAt?: string }) => ({ id: r.id, status: r.status, startedAt: r.startedAt })))
      const latest = data?.latest as FlowRunDetail | null
      if (!latest) return
      setSelectedRun(latest)
      const map: Record<string, StepStatus> = {}
      for (const step of latest.steps as { nodeId: string; status: StepStatus }[]) map[step.nodeId] = step.status
      setStatusByNode(map)
      if (['succeeded', 'failed'].includes(latest.status) && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [id])

  const selectRun = useCallback(
    async (runId: string) => {
      const data = await fetch(`/api/flows/${id}/runs`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      const found = (data?.runs as FlowRunDetail[] | undefined)?.find((r) => r.id === runId)
      if (found) setSelectedRun(found)
    },
    [id],
  )

  const run = useCallback(async () => {
    setRunning(true)
    setMode('test')
    setShowRuns(true)
    setStatusByNode({})
    try {
      if (!(await save())) return
      pollRuns()
      const response = await fetch(`/api/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) toast.error(data.error || 'Run failed.')
      else if (data.run?.status === 'waiting') toast('The flow paused for input on a step.')
      else if (data.run?.status === 'failed') toast.error('The flow failed — check the step statuses.')
      else toast.success('Flow ran.')
      pollRuns()
    } finally {
      setRunning(false)
    }
  }, [id, save, pollRuns, testInput])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border p-3">
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="mx-auto h-96 max-w-xl rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" onClick={() => router.push('/flows')} aria-label="Back to flows">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-base font-semibold outline-none hover:bg-muted focus:bg-muted"
          placeholder="Untitled flow"
        />
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(['build', 'test'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn('px-3 py-1.5 text-xs font-medium capitalize', mode === m ? 'bg-indigo-600 text-white' : 'text-muted-foreground hover:bg-muted')}
            >
              {m}
            </button>
          ))}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <input
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="Test input…"
          title="Value passed to {{trigger.input}} on Run"
          className="w-40 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
        />
        <Button variant="outline" size="sm" onClick={() => setShowRuns((v) => !v)}>
          <ListChecks className="mr-1.5 h-4 w-4" /> Runs
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowCopilot((v) => !v)}>
          <Sparkles className="mr-1.5 h-4 w-4" /> Copilot
        </Button>
        <Button variant="outline" size="sm" onClick={save} loading={saving}>
          <Save className="mr-1.5 h-4 w-4" /> Save
        </Button>
        <Button size="sm" onClick={run} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Run
        </Button>
      </div>

      {/* Body: canvas + optional drawer + optional copilot */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto bg-muted/30 p-8">
          <FlowCanvas
            graph={graph}
            agentName={(agentId) => agentsById.get(agentId) ?? ''}
            statusByNode={mode === 'test' ? statusByNode : {}}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onInsertAfter={(afterId) => {
              const { graph: next, nodeId } = insertAgentAfter(graph, afterId, agents[0]?.id ?? '')
              setGraph(next)
              setSelectedId(nodeId)
            }}
          />
        </div>

        {selectedNode && (
          <div className="w-80 shrink-0">
            <StepDrawer
              node={selectedNode}
              agents={agents}
              upstreamNodeIds={upstreamIds}
              insideLoop={insideLoop}
              onChange={(node) => setGraph((g) => updateNode(g, node))}
              onChangeType={(type) => setGraph((g) => changeNodeType(g, selectedNode.id, type))}
              onDelete={() => {
                setGraph((g) => deleteNode(g, selectedNode.id))
                setSelectedId(null)
              }}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}

        {showCopilot && (
          <div className="w-80 shrink-0">
            <CopilotPanel
              onGraph={(next) => {
                setGraph(next as FlowGraph)
                setSelectedId(null)
                setShowCopilot(false)
              }}
            />
          </div>
        )}

        {showRuns && (
          <div className="w-80 shrink-0">
            <RunPanel
              runs={runs}
              selected={selectedRun}
              onSelectRun={selectRun}
              onClose={() => setShowRuns(false)}
              labelForNode={(nodeId) => {
                const node = graph.nodes.find((n) => n.id === nodeId)
                if (!node) return nodeId
                if (node.type === 'agent') return node.data.label || agentsById.get(node.data.agentId) || 'Agent step'
                return node.type.charAt(0).toUpperCase() + node.type.slice(1)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
