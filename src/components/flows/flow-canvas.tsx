'use client'

import { Fragment, useMemo, useState } from 'react'
import {
  Bot,
  CircleStop,
  Filter,
  GitBranch,
  Globe,
  Plus,
  Repeat,
  Rows3,
  Search,
  SlidersHorizontal,
  Sparkles,
  Split,
  Wrench,
} from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { StepType } from '@/lib/flows/mutate'
import type { DataField } from '@/lib/flows/datatree'
import { StepCard, type StepStatus } from './step-card'
import type { ToolCatalog } from './step-drawer'

type Agent = { id: string; title: string }

export type FlowInsertSeed = {
  agentId?: string
  connectionId?: string
  toolName?: string
  label?: string
}

type PickerItem = {
  id: string
  type: StepType
  label: string
  description: string
  icon: typeof Bot
  tone: string
  seed?: FlowInsertSeed
  connector?: { id: string; name: string }
}

const BUILT_IN_ITEMS: PickerItem[] = [
  {
    id: 'http',
    type: 'http',
    label: 'HTTP request',
    description: 'Send data to an API endpoint and use its response in later steps.',
    icon: Globe,
    tone: 'bg-emerald-600 text-white',
  },
  {
    id: 'transform',
    type: 'transform',
    label: 'Set fields',
    description: 'Create named values that downstream steps can reuse.',
    icon: SlidersHorizontal,
    tone: 'bg-violet-500 text-white',
  },
  {
    id: 'condition',
    type: 'condition',
    label: 'If / else',
    description: 'Route the flow down different paths based on a rule.',
    icon: GitBranch,
    tone: 'bg-amber-500 text-white',
  },
  {
    id: 'switch',
    type: 'switch',
    label: 'Switch',
    description: 'Route to one of several cases, with a default path.',
    icon: Split,
    tone: 'bg-fuchsia-600 text-white',
  },
  {
    id: 'filter',
    type: 'filter',
    label: 'Filter',
    description: 'Continue only when an item or value matches a rule.',
    icon: Filter,
    tone: 'bg-lime-600 text-white',
  },
  {
    id: 'loop',
    type: 'loop',
    label: 'For each',
    description: 'Run steps once for each item in a list.',
    icon: Repeat,
    tone: 'bg-sky-500 text-white',
  },
  {
    id: 'parallel',
    type: 'parallel',
    label: 'Parallel branches',
    description: 'Run independent branches at the same time.',
    icon: Rows3,
    tone: 'bg-cyan-600 text-white',
  },
  {
    id: 'stop',
    type: 'stop',
    label: 'Stop flow',
    description: 'End the flow early with an optional message.',
    icon: CircleStop,
    tone: 'bg-red-500 text-white',
  },
]

function matchesQuery(item: PickerItem, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return `${item.label} ${item.description} ${item.connector?.name ?? ''}`.toLowerCase().includes(normalized)
}

function InsertMenu({
  onPick,
  agents,
  toolCatalog,
  compact,
}: {
  onPick: (type: StepType, seed?: FlowInsertSeed) => void
  agents: Agent[]
  toolCatalog: ToolCatalog
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const agentItems = useMemo<PickerItem[]>(() => {
    if (!agents.length) {
      return [
        {
          id: 'agent',
          type: 'agent',
          label: 'Run an agent',
          description: 'Add an agent step, then choose which agent to run.',
          icon: Bot,
          tone: 'bg-slate-900 text-white',
        },
      ]
    }
    return agents.map((agent) => ({
      id: `agent-${agent.id}`,
      type: 'agent',
      label: agent.title,
      description: 'Run this agent and pass its response to the next step.',
      icon: Bot,
      tone: 'bg-slate-900 text-white',
      seed: { agentId: agent.id },
    }))
  }, [agents])

  const connectorItems = useMemo<PickerItem[]>(
    () =>
      toolCatalog.map((connection) => ({
        id: `connection-${connection.id}`,
        type: 'tool',
        label: connection.name,
        description: connection.tools.length
          ? `${connection.tools.length} available action${connection.tools.length === 1 ? '' : 's'}`
          : 'Choose an action from this connection.',
        icon: Wrench,
        tone: 'bg-orange-500 text-white',
        seed: {
          connectionId: connection.id,
          toolName: connection.tools[0]?.name ?? '',
        },
        connector: { id: connection.id, name: connection.name },
      })),
    [toolCatalog],
  )

  const filteredAgents = agentItems.filter((item) => matchesQuery(item, query))
  const filteredBuiltIn = BUILT_IN_ITEMS.filter((item) => matchesQuery(item, query))
  const filteredConnectors = connectorItems.filter((item) => matchesQuery(item, query))

  const pick = (item: PickerItem) => {
    setOpen(false)
    setQuery('')
    onPick(item.type, item.seed)
  }

  return (
    <div className={cn('relative flex flex-col items-center', compact && 'items-start')} onClick={(event) => event.stopPropagation()}>
      {!compact && <div className="h-8 w-px bg-slate-300" />}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Add step"
        className={cn(
          'group flex items-center justify-center border bg-white text-slate-600 shadow-sm transition-all hover:border-blue-400 hover:text-blue-700 hover:shadow-md',
          compact
            ? 'gap-2 rounded-lg border-dashed px-3 py-2 text-sm font-semibold'
            : 'h-9 w-9 rounded-full border-slate-300',
        )}
      >
        <Plus className={cn('h-5 w-5', compact && 'h-4 w-4')} />
        {compact && 'Add a step'}
      </button>
      {!compact && <div className="h-8 w-px bg-slate-300" />}

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'absolute z-30 mt-2 max-h-[72vh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]',
              compact ? 'left-0 top-full w-[min(620px,calc(100vw-4rem))]' : 'left-1/2 top-full w-[min(720px,calc(100vw-4rem))] -translate-x-1/2',
            )}
          >
            <div className="border-b border-slate-200 p-4">
              <p className="text-lg font-semibold text-slate-950">Add an action</p>
              <p className="mt-1 text-sm text-slate-500">Choose what should happen next in this flow.</p>
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-slate-400"
                  placeholder="Search agents, actions, or connectors"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-[calc(72vh-126px)] space-y-5 overflow-y-auto p-4">
              <PickerSection title="AI capabilities" items={filteredAgents} onPick={pick} />
              <PickerSection title="Built-in tools" items={filteredBuiltIn} onPick={pick} />
              {toolCatalog.length > 0 ? (
                <PickerSection title="Connected tools" items={filteredConnectors} onPick={pick} />
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                  Connected tools will show here after this workspace has integrations available.
                </div>
              )}
              {filteredAgents.length + filteredBuiltIn.length + filteredConnectors.length === 0 && (
                <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No matching actions found.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function PickerSection({ title, items, onPick }: { title: string; items: PickerItem[]; onPick: (item: PickerItem) => void }) {
  if (!items.length) return null
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{title}</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onPick(item)}
              className="flex min-h-[84px] items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
            >
              {item.connector ? (
                <IntegrationLogo slug={item.connector.id} name={item.connector.name} className="h-10 w-10 rounded-lg bg-white p-1 shadow-sm" />
              ) : (
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', item.tone)}>
                  <Icon className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-950">{item.label}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-slate-500">{item.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function FlowCanvas({
  graph,
  agentName,
  agents,
  toolCatalog,
  dataFields,
  statusByNode,
  selectedId,
  onSelect,
  onChangeNode,
  onInsertAfter,
  onAppendBranch,
  onRefreshAgents,
  onDuplicateNode,
  onDeleteNode,
  onBackgroundClick,
}: {
  graph: FlowGraph
  agentName: (agentId: string) => string
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  statusByNode: Record<string, StepStatus>
  selectedId: string | null
  onSelect: (nodeId: string) => void
  onChangeNode: (node: FlowNode) => void
  onInsertAfter: (afterId: string, type: StepType, seed?: FlowInsertSeed) => void
  onAppendBranch: (conditionId: string, branch: string, type: StepType, seed?: FlowInsertSeed) => void
  onRefreshAgents?: () => void
  onDuplicateNode?: (id: string) => void
  onDeleteNode?: (id: string) => void
  onBackgroundClick?: () => void
}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nextOf = (id: string): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === id && !e.branch)
    return edge ? byId.get(edge.target) : undefined
  }
  const branchHead = (conditionId: string, branch: string): FlowNode | undefined => {
    const edge = graph.edges.find((e) => e.source === conditionId && e.branch === branch)
    return edge ? byId.get(edge.target) : undefined
  }
  const contained = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  const titleFor = (node: FlowNode): string => {
    switch (node.type) {
      case 'trigger': {
        const type = (node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'
        if (type === 'schedule') return 'Schedule trigger'
        if (type === 'webhook') return 'Webhook trigger'
        return 'Manually trigger a flow'
      }
      case 'agent':
        return node.data.label || agentName(node.data.agentId) || 'Run an agent'
      case 'condition': {
        const clause = node.data.clauses?.[0] ?? (node.data.left !== undefined ? { left: node.data.left, op: node.data.op, right: node.data.right } : null)
        const extra = (node.data.clauses?.length ?? 1) > 1 ? ` +${node.data.clauses!.length - 1}` : ''
        return node.data.label || (clause?.left ? `If ${clause.left} ${clause.op} ${clause.right}${extra}` : 'If / else')
      }
      case 'loop':
        return node.data.label || 'For each'
      case 'parallel':
        return node.data.label || 'Parallel branches'
      case 'stop':
        return node.data.label || 'Stop flow'
      case 'tool':
        return node.data.label || node.data.toolName || 'Run a connected tool'
      case 'http':
        return node.data.label || 'HTTP request'
      case 'transform':
        return node.data.label || 'Set fields'
      case 'filter':
        return node.data.label || 'Filter'
      case 'switch':
        return node.data.label || 'Switch'
    }
  }

  const subtitleFor = (node: FlowNode): string | undefined => {
    switch (node.type) {
      case 'trigger': {
        const inputCount = ((node.data.trigger as { inputFields?: unknown[] } | undefined)?.inputFields ?? []).length
        return inputCount ? `${inputCount} input${inputCount === 1 ? '' : 's'}` : 'Add fields users fill in before the flow runs.'
      }
      case 'agent':
        return agentName(node.data.agentId) || 'Choose an agent'
      case 'loop':
        return node.data.over === '{{trigger.input}}' ? 'Loop over trigger input' : `Loop over ${node.data.over}`
      case 'parallel':
        return `${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'}`
      case 'stop':
        return node.data.reason || undefined
      case 'tool':
        return node.data.toolName || 'Choose connection and action'
      case 'http':
        return node.data.url ? `${node.data.method} ${node.data.url}` : 'Configure an API request'
      case 'transform':
        return `${node.data.fields.length} field${node.data.fields.length === 1 ? '' : 's'}`
      case 'filter':
        return node.data.note || 'Continue only if a rule matches'
      case 'switch':
        return node.data.note || `${node.data.cases.length} case${node.data.cases.length === 1 ? '' : 's'}`
      default:
        return (node.data as { note?: string }).note || undefined
    }
  }

  const card = (node: FlowNode, index?: number) => (
    <StepCard
      node={node}
      index={index}
      title={titleFor(node)}
      subtitle={subtitleFor(node)}
      status={statusByNode[node.id]}
      selected={selectedId === node.id}
      agents={agents}
      toolCatalog={toolCatalog}
      dataFields={selectedId === node.id ? dataFields : undefined}
      onChange={onChangeNode}
      onClick={() => onSelect(node.id)}
      onRefreshAgents={onRefreshAgents}
      onDuplicate={node.type === 'trigger' ? undefined : onDuplicateNode ? () => onDuplicateNode(node.id) : undefined}
      onDelete={node.type === 'trigger' ? undefined : onDeleteNode ? () => onDeleteNode(node.id) : undefined}
    />
  )

  const nestedCards = (node: FlowNode) => {
    const ids = node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : []
    const nodes = ids.map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
    if (!nodes.length) return null
    return (
      <div className="my-3 ml-10 space-y-3 border-l-2 border-dashed border-slate-300 pl-4">
        {nodes.map((body, bodyIndex) => (
          <Fragment key={body.id}>{card(body, bodyIndex + 1)}</Fragment>
        ))}
      </div>
    )
  }

  const renderChain = (start: FlowNode | undefined, seen: Set<string>): React.ReactNode => {
    const parts: React.ReactNode[] = []
    let current = start
    while (current && !seen.has(current.id) && !contained.has(current.id)) {
      seen.add(current.id)
      const node = current
      parts.push(
        <Fragment key={node.id}>
          {card(node)}
          {nestedCards(node)}
        </Fragment>,
      )
      if (node.type === 'condition') {
        parts.push(
          <div key={`${node.id}-branches`} className="my-3 grid gap-4 md:grid-cols-2">
            {(['true', 'false'] as const).map((branch) => (
              <div key={branch} className="rounded-2xl border border-dashed border-slate-300 bg-white/75 p-3">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {branch === 'true' ? 'Then' : 'Otherwise'}
                </p>
                <div className="space-y-3">
                  {renderChain(branchHead(node.id, branch), seen)}
                  <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, branch, type, seed)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts
      }
      if (node.type === 'switch') {
        const branches = [...node.data.cases.map((c) => ({ key: c.id, label: c.label || `${c.left} ${c.op} ${c.right}` })), { key: 'default', label: 'default' }]
        parts.push(
          <div key={`${node.id}-cases`} className="my-3 grid gap-4 md:grid-cols-2">
            {branches.map((branch) => (
              <div key={branch.key} className="rounded-2xl border border-dashed border-slate-300 bg-white/75 p-3">
                <p className="mb-3 truncate text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{branch.label}</p>
                <div className="space-y-3">
                  {renderChain(branchHead(node.id, branch.key), seen)}
                  <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onAppendBranch(node.id, branch.key, type, seed)} />
                </div>
              </div>
            ))}
          </div>,
        )
        return parts
      }
      const next = nextOf(node.id)
      if (next && !contained.has(next.id) && !seen.has(next.id)) {
        parts.push(
          <InsertMenu key={`${node.id}-insert`} agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(node.id, type, seed)} />,
        )
      } else {
        parts.push(
          <div key={`${node.id}-tail`} className="flex flex-col items-center">
            <div className="h-2 w-px bg-slate-300" />
            <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(node.id, type, seed)} />
          </div>,
        )
      }
      current = next
    }
    return parts
  }

  const trigger = byId.get('trigger') ?? graph.nodes[0]
  const first = trigger ? nextOf(trigger.id) : undefined
  const seen = new Set<string>(trigger ? [trigger.id] : [])

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center py-8" onClick={() => onBackgroundClick?.()}>
      <div className="mb-6 flex items-center gap-2 self-start rounded-full border border-blue-100 bg-white/85 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm">
        <Sparkles className="h-3.5 w-3.5" />
        Designer
      </div>
      <div className="flex w-full flex-col items-center">
        {trigger && card(trigger)}
        {trigger && !first && (
          <div className="flex flex-col items-center">
            <InsertMenu agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(trigger.id, type, seed)} />
          </div>
        )}
        {trigger && first && <InsertMenu agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(trigger.id, type, seed)} />}
        {renderChain(first, seen)}
      </div>
    </div>
  )
}
