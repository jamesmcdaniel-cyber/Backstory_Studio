'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Play, Save, Sparkles, Loader2, ListChecks, Undo2, Redo2, MoreHorizontal, Copy, Download, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { emptyGraph, type FlowGraph, type FlowNode, type OutputField } from '@/lib/flows/graph'
import { insertNodeAfter, appendToBranch, duplicateNode, updateNode, deleteNode, changeNodeType, addContainerStep } from '@/lib/flows/mutate'
import { buildDataTree } from '@/lib/flows/datatree'
import { parseFlowInput } from '@/lib/flows/input'
import { httpOutputFields, outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import { validateFlowGraph } from '@/lib/flows/validate'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { FlowCanvas, type FlowInsertSeed } from '@/components/flows/flow-canvas'
import { StepDrawer, type ToolCatalog } from '@/components/flows/step-drawer'
import { CopilotPanel } from '@/components/flows/copilot-panel'
import { RunPanel, type FlowRunDetail } from '@/components/flows/run-panel'
import { ResizablePanel } from '@/components/flows/resizable-panel'
import { TestInputPanel } from '@/components/flows/test-input-panel'
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

function parentLoop(graph: FlowGraph, nodeId: string | null): { loop: Extract<FlowNode, { type: 'loop' }>; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'loop') continue
    const index = node.data.body.indexOf(nodeId)
    if (index >= 0) return { loop: node, index }
  }
  return null
}

function parentParallelBranch(graph: FlowGraph, nodeId: string | null): { parallelId: string; branch: string[]; index: number } | null {
  if (!nodeId) return null
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    for (const branch of node.data.branches) {
      const index = branch.indexOf(nodeId)
      if (index >= 0) return { parallelId: node.id, branch, index }
    }
  }
  return null
}

function parseFlowValue(value: unknown) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function storedRunInput(input: unknown): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, 'prompt')) {
    return (input as Record<string, unknown>).prompt
  }
  return input
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerInputFields(graph: FlowGraph) {
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  return triggerInputFieldsFromTrigger(triggerNode?.data.trigger)
}

function outputFieldsForNode(node: FlowNode | undefined, toolCatalog: ToolCatalog): OutputField[] | undefined {
  if (!node) return undefined
  if (node.type === 'agent') return node.data.outputFields
  if (node.type === 'http') return node.data.outputFields?.length ? node.data.outputFields : httpOutputFields()
  if (node.type !== 'tool') return undefined
  if (node.data.outputFields?.length) return node.data.outputFields
  const tool = toolCatalog
    .find((connection) => connection.id === node.data.connectionId)
    ?.tools.find((entry) => entry.name === node.data.toolName)
  const fields = outputFieldsFromJsonSchema(tool?.outputSchema)
  return fields.length ? fields : undefined
}

function previewLoopItems(value: unknown): unknown[] {
  const parsed = parseFlowValue(value)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const candidate = (parsed as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) return candidate
    }
    return []
  }
  if (typeof parsed !== 'string') return []
  const trimmed = parsed.trim()
  if (!trimmed) return []
  const lines = trimmed.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const commaParts = trimmed.split(',').map((part) => part.trim()).filter(Boolean)
  return commaParts.length > 1 ? commaParts : [trimmed]
}

function sampleLoopItem(loop: Extract<FlowNode, { type: 'loop' }>, lastOutputs: Record<string, unknown>, testInput: string): unknown {
  const token = loop.data.over.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)?.[1]
  let value: unknown = loop.data.over
  if (token === 'trigger.input') {
    value = testInput
  } else if (token?.startsWith('step.')) {
    const [, nodeId, outputKey, ...rest] = token.split('.')
    if (outputKey === 'output') {
      value = lastOutputs[nodeId]
      for (const part of rest) {
        if (value == null || typeof value !== 'object') {
          value = undefined
          break
        }
        value = (value as Record<string, unknown>)[part]
      }
    }
  }
  return previewLoopItems(value)[0]
}

function filenameSlug(value: string): string {
  return (value || 'flow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'flow'
}

export default function FlowBuilder() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [graph, setGraph] = useState<FlowGraph>(emptyGraph())
  const [status, setStatus] = useState('draft')
  const [version, setVersion] = useState(1)
  const [published, setPublished] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [mode, setMode] = useState<'build' | 'test'>('build')
  // Copilot is the workflow-building assistant — open by default so it's always
  // there; the top-bar toggle can still hide it.
  const [showCopilot, setShowCopilot] = useState(true)
  const [showRuns, setShowRuns] = useState(false)
  const [showTestInput, setShowTestInput] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusByNode, setStatusByNode] = useState<Record<string, StepStatus>>({})
  const [testInput, setTestInput] = useState('')
  const [runs, setRuns] = useState<{ id: string; status: string; startedAt?: string }[]>([])
  const [selectedRun, setSelectedRun] = useState<FlowRunDetail | null>(null)
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>([])
  // Serialized snapshot of the last-saved state, for the unsaved-changes dot.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dirty = savedSnapshot !== '' && JSON.stringify({ name, description, graph, status }) !== savedSnapshot

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
          const g = flow.graph && flow.graph.nodes ? flow.graph : emptyGraph()
          setName(flow.name)
          setDescription(flow.description || '')
          setGraph(g)
          setStatus(flow.status)
          setVersion(flow.version ?? 1)
          setPublished(Boolean(flow.published))
          setSavedSnapshot(JSON.stringify({ name: flow.name, description: flow.description || '', graph: g, status: flow.status }))
        }
        setAgents(agentsData.success ? agentsData.agents.map((a: Agent) => ({ id: a.id, title: a.title })) : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // The tool catalog loads separately — discovery can be slow and must not
    // block the canvas paint.
    fetch('/api/flows/tool-catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setToolCatalog(data.connections)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Undo/redo history over structural graph edits (not per-keystroke field edits).
  const undoStack = useRef<FlowGraph[]>([])
  const redoStack = useRef<FlowGraph[]>([])
  const commitGraph = useCallback(
    (next: FlowGraph) => {
      undoStack.current.push(graph)
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
      setGraph(next)
    },
    [graph],
  )
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(graph)
    setGraph(prev)
    setSelectedId(null)
  }, [graph])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(graph)
    setGraph(next)
    setSelectedId(null)
  }, [graph])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a.title])), [agents])
  const inputFields = useMemo(() => triggerInputFields(graph), [graph])
  const hasInputFields = inputFields.some((field) => field.name.trim())
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null
  const loopContext = useMemo(() => parentLoop(graph, selectedId), [graph, selectedId])
  const parallelContext = useMemo(() => parentParallelBranch(graph, selectedId), [graph, selectedId])
  const insideLoop = Boolean(loopContext)
  const upstreamIds = useMemo(() => {
    const ids = spineIds(graph)
    if (loopContext) {
      const loopIdx = ids.indexOf(loopContext.loop.id)
      return [
        ...(loopIdx > 0 ? ids.slice(1, loopIdx) : []),
        ...loopContext.loop.data.body.slice(0, loopContext.index),
      ].filter((x) => x !== selectedId)
    }
    if (parallelContext) {
      const parallelIdx = ids.indexOf(parallelContext.parallelId)
      return [
        ...(parallelIdx > 0 ? ids.slice(1, parallelIdx) : []),
        ...parallelContext.branch.slice(0, parallelContext.index),
      ].filter((x) => x !== selectedId)
    }
    const idx = ids.indexOf(selectedId ?? '')
    return (idx > 0 ? ids.slice(1, idx) : ids.slice(1)).filter((x) => x !== selectedId)
  }, [graph, selectedId, loopContext, parallelContext])

  // The datatree of mappable upstream data — declared output fields plus fields
  // inferred from the latest run's actual output.
  const dataFields = useMemo(() => {
    if (!selectedNode || selectedNode.type === 'trigger') return []
    const lastOutputs: Record<string, unknown> = {}
    for (const step of selectedRun?.steps ?? []) lastOutputs[step.nodeId] = parseFlowValue(step.output)
    const triggerInput = testInput.trim() ? parseFlowInput(testInput) : storedRunInput(selectedRun?.input)
    if (loopContext) {
      const sampleInput = typeof triggerInput === 'string' ? triggerInput : triggerInput == null ? '' : JSON.stringify(triggerInput)
      lastOutputs.__item = sampleLoopItem(loopContext.loop, lastOutputs, sampleInput)
    }
    const upstream = upstreamIds.map((uid) => {
      const n = graph.nodes.find((x) => x.id === uid)
      const label =
        n?.type === 'agent'
          ? n.data.label || agentsById.get(n.data.agentId) || 'Agent step'
          : n?.type === 'tool'
            ? n.data.label || n.data.toolName || 'Tool call'
            : n?.type === 'http'
              ? n.data.label || `${n.data.method} request`
              : n
                ? n.type
                : uid
      const outputFields = outputFieldsForNode(n, toolCatalog)
      return { id: uid, label, outputFields }
    })
    return buildDataTree({ upstream, insideLoop, lastOutputs, triggerInput, inputFields })
  }, [selectedNode, upstreamIds, graph, selectedRun, insideLoop, agentsById, loopContext, testInput, inputFields, toolCatalog])

  const validation = useMemo(
    () => validateFlowGraph(graph, { agents, toolCatalog }),
    [graph, agents, toolCatalog],
  )

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, description, graph, status: status.toUpperCase() }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not save the flow.')
        return false
      }
      setSavedSnapshot(JSON.stringify({ name, description, graph, status }))
      return true
    } finally {
      setSaving(false)
    }
  }, [id, name, description, graph, status])

  const publish = useCallback(
    async (revert = false) => {
      setPublishing(true)
      try {
        if (!revert && !validation.ok) {
          toast.error(validation.errors[0]?.message || 'Fix the flow before publishing.')
          return
        }
        if (!revert && !(await save())) return
        const response = await fetch(`/api/flows/${id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revert }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          toast.error(data.error || 'Could not publish.')
          return
        }
        if (revert && data.flow?.graph) setGraph(data.flow.graph)
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        toast.success(revert ? 'Reverted to the published version.' : `Published v${data.flow?.version}.`)
      } finally {
        setPublishing(false)
      }
    },
    [id, save, validation, version],
  )

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
    if (!validation.ok) {
      toast.error(validation.errors[0]?.message || 'Fix the flow before running.')
      setMode('build')
      return
    }
    const missing = missingRequiredInputFields(inputFields, parseFlowInput(testInput))
    if (missing.length) {
      toast.error(`Fill the required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
      setShowTestInput(true)
      setMode('build')
      return
    }
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
  }, [id, save, pollRuns, testInput, validation, inputFields])

  const fixWithCopilot = useCallback(async () => {
    setFixing(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Fix the validation problems in this flow.',
          currentGraph: graph,
          issues: [...validation.errors, ...validation.warnings].map((issue) => issue.message),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.success && data.graph) {
        commitGraph(data.graph)
        setSelectedId(null)
        const remainingErrors = data.validation?.errors?.length ?? 0
        if (remainingErrors) {
          toast.warning(`Copilot applied fixes — ${remainingErrors} check${remainingErrors === 1 ? '' : 's'} still need attention.`)
        } else {
          toast.success('Copilot applied fixes — review the changes.')
        }
      } else {
        toast.error(data.error || 'Could not fix the flow.')
      }
    } finally {
      setFixing(false)
    }
  }, [graph, validation, commitGraph])

  const duplicateFlow = useCallback(async () => {
    const flowName = name.trim() || 'Untitled flow'
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${flowName} copy`,
        description,
        graph,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && data.flow?.id) {
      toast.success('Flow duplicated.')
      router.push(`/flows/${data.flow.id}`)
    } else {
      toast.error(data.error || 'Could not duplicate the flow.')
    }
  }, [name, description, graph, router])

  const downloadFlow = useCallback(() => {
    const flowName = name.trim() || 'Untitled flow'
    const payload = {
      name: flowName,
      description,
      status,
      version,
      graph,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${filenameSlug(flowName)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [name, description, status, version, graph])

  const deleteFlow = useCallback(async () => {
    const flowName = name.trim() || 'this flow'
    if (!window.confirm(`Delete "${flowName}"? This cannot be undone.`)) return
    const response = await fetch('/api/flows', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok) {
      toast.success('Flow deleted.')
      router.push('/flows')
    } else {
      toast.error(data.error || 'Could not delete the flow.')
    }
  }, [id, name, router])

  const refreshAgents = useCallback(async () => {
    const data = await fetch('/api/agents', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) setAgents(data.agents.map((a: Agent) => ({ id: a.id, title: a.title })))
  }, [])

  const applyInsertSeed = useCallback((next: FlowGraph, nodeId: string, seed?: FlowInsertSeed): FlowGraph => {
    if (!seed) return next
    const node = next.nodes.find((entry) => entry.id === nodeId)
    if (!node) return next
    if (node.type === 'agent') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          agentId: seed.agentId ?? node.data.agentId,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    if (node.type === 'tool') {
      return updateNode(next, {
        ...node,
        data: {
          ...node.data,
          connectionId: seed.connectionId ?? node.data.connectionId,
          toolName: seed.toolName ?? node.data.toolName,
          ...(seed.label ? { label: seed.label } : {}),
        },
      })
    }
    return next
  }, [])

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
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo" title="Undo (⌘Z)">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={redo} aria-label="Redo" title="Redo (⌘⇧Z)">
          <Redo2 className="h-4 w-4" />
        </Button>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Flow settings" title="Flow settings">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Flow settings</DropdownMenuLabel>
            <DropdownMenuItem onSelect={duplicateFlow}>
              <Copy className="h-4 w-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={downloadFlow}>
              <Download className="h-4 w-4" /> Download JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={deleteFlow} className="text-red-600 focus:text-red-700">
              <Trash2 className="h-4 w-4" /> Delete flow
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {hasInputFields ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowTestInput((open) => !open)}
            title="Fill the values passed to this flow when you click Run"
          >
            Test input
          </Button>
        ) : (
          <input
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Run input..."
            title="Value passed to the flow when you click Run. Lists can be JSON or comma-separated."
            className="w-40 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-indigo-400"
          />
        )}
        <Button variant="outline" size="sm" onClick={() => setShowRuns((v) => !v)}>
          <ListChecks className="mr-1.5 h-4 w-4" /> Runs
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowCopilot((v) => !v)}>
          <Sparkles className="mr-1.5 h-4 w-4" /> Copilot
        </Button>
        <Button variant="outline" size="sm" onClick={save} loading={saving} className="relative">
          <Save className="mr-1.5 h-4 w-4" /> Save
          {dirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400" title="Unsaved changes" />}
        </Button>
        <Button variant="outline" size="sm" onClick={() => publish(false)} loading={publishing} title={published ? `Published v${version}` : 'Not yet published'}>
          {published ? `Publish v${version + 1}` : 'Publish'}
        </Button>
        {published && (
          <Button variant="ghost" size="sm" onClick={() => publish(true)} title="Discard draft changes and restore the published version">
            Revert
          </Button>
        )}
        <Button size="sm" onClick={run} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Run
        </Button>
      </div>

      {hasInputFields && (showTestInput || mode === 'test') && (
        <TestInputPanel fields={inputFields} value={testInput} onChange={setTestInput} />
      )}

      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="border-b border-border bg-amber-50 px-4 py-2 text-amber-950">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold">Flow checks</p>
                {validation.errors.length > 0 && <Badge variant="risk">{validation.errors.length} error{validation.errors.length === 1 ? '' : 's'}</Badge>}
                {validation.warnings.length > 0 && <Badge variant="warn">{validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'}</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-900">
                {[...validation.errors, ...validation.warnings].slice(0, 4).map((issue) => (
                  <span key={`${issue.code}-${issue.nodeId ?? 'flow'}-${issue.message}`}>{issue.message}</span>
                ))}
                {validation.issues.length > 4 && <span>{validation.issues.length - 4} more checks need attention.</span>}
              </div>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={fixWithCopilot} loading={fixing} disabled={fixing}>
              <Sparkles className="mr-1.5 h-4 w-4" /> Fix with Copilot
            </Button>
          </div>
        </div>
      )}

      {/* Body: canvas + optional drawer + optional copilot */}
      <div className="flex min-h-0 flex-1">
        <div
          className="min-w-0 flex-1 overflow-y-auto bg-white p-8"
          onClick={() => setSelectedId(null)}
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15, 23, 42, 0.22) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        >
          <FlowCanvas
            graph={graph}
            agentName={(agentId) => agentsById.get(agentId) ?? ''}
            agents={agents}
            toolCatalog={toolCatalog}
            dataFields={dataFields}
            statusByNode={mode === 'test' ? statusByNode : {}}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onBackgroundClick={() => setSelectedId(null)}
            onChangeNode={(node) => setGraph((g) => updateNode(g, node))}
            onInsertAfter={(afterId, type, seed) => {
              const { graph: inserted, nodeId } = insertNodeAfter(graph, afterId, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
              const next = applyInsertSeed(inserted, nodeId, seed)
              commitGraph(next)
              setSelectedId(nodeId)
            }}
            onAppendBranch={(conditionId, branch, type, seed) => {
              const { graph: inserted, nodeId } = appendToBranch(graph, conditionId, branch, type, type === 'agent' ? seed?.agentId ?? agents[0]?.id ?? '' : undefined)
              const next = applyInsertSeed(inserted, nodeId, seed)
              commitGraph(next)
              setSelectedId(nodeId)
            }}
            onRefreshAgents={refreshAgents}
            onDuplicateNode={(nodeId) => {
              const { graph: next, nodeId: newId } = duplicateNode(graph, nodeId)
              commitGraph(next)
              setSelectedId(newId)
            }}
            onDeleteNode={(nodeId) => {
              commitGraph(deleteNode(graph, nodeId))
              if (selectedId === nodeId) setSelectedId(null)
            }}
            onPickTrigger={(type) => {
              const triggerNode = graph.nodes.find((n) => n.type === 'trigger')
              if (!triggerNode || triggerNode.type !== 'trigger') return
              const current = isRecordLike(triggerNode.data.trigger) ? triggerNode.data.trigger : {}
              commitGraph(updateNode(graph, { ...triggerNode, data: { trigger: { ...current, type } } }))
              setSelectedId(triggerNode.id)
            }}
          />
        </div>

        {selectedNode && (
          <ResizablePanel storageKey="flow.drawerWidth">
            <StepDrawer
              node={selectedNode}
              flowId={id}
              agents={agents}
              toolCatalog={toolCatalog}
              dataFields={dataFields}
              onChange={(node) => setGraph((g) => updateNode(g, node))}
              onChangeType={(type) => commitGraph(changeNodeType(graph, selectedNode.id, type))}
              onDuplicate={() => {
                const { graph: next, nodeId } = duplicateNode(graph, selectedNode.id)
                commitGraph(next)
                setSelectedId(nodeId)
              }}
              onAddStep={
                selectedNode.type === 'loop' || selectedNode.type === 'parallel'
                  ? (type) => {
                      const { graph: next, nodeId } = addContainerStep(graph, selectedNode.id, type, type === 'agent' ? agents[0]?.id ?? '' : undefined)
                      commitGraph(next)
                      setSelectedId(nodeId)
                    }
                  : undefined
              }
              onDelete={() => {
                commitGraph(deleteNode(graph, selectedNode.id))
                setSelectedId(null)
              }}
              onClose={() => setSelectedId(null)}
            />
          </ResizablePanel>
        )}

        {showCopilot && (
          <ResizablePanel storageKey="flow.copilotWidth">
            <CopilotPanel
              onGraph={(next) => {
                commitGraph(next as FlowGraph)
                setSelectedId(null)
                // Keep Copilot open so the user can keep iterating on the draft.
              }}
            />
          </ResizablePanel>
        )}

        {showRuns && (
          <ResizablePanel storageKey="flow.runsWidth">
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
          </ResizablePanel>
        )}
      </div>
    </div>
  )
}
