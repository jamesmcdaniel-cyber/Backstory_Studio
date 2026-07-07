'use client'

import { Fragment } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { StepCard, type StepStatus } from './step-card'

/** Walk the main chain from the trigger into an ordered list (cycle-guarded). */
function spineOf(graph: FlowGraph): FlowNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const primaryTarget = (id: string, type: FlowNode['type']): string | undefined => {
    const edges = graph.edges.filter((edge) => edge.source === id)
    if (type === 'condition') return (edges.find((edge) => edge.branch === 'true') ?? edges[0])?.target
    return edges[0]?.target
  }
  const spine: FlowNode[] = []
  const seen = new Set<string>()
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    spine.push(current)
    const next = primaryTarget(current.id, current.type)
    current = next ? byId.get(next) : undefined
  }
  return spine
}

function conditionText(node: Extract<FlowNode, { type: 'condition' }>): string {
  return `If ${node.data.left} ${node.data.op} ${node.data.right}`
}

export function FlowCanvas({
  graph,
  agentName,
  statusByNode,
  selectedId,
  onSelect,
  onInsertAfter,
}: {
  graph: FlowGraph
  agentName: (agentId: string) => string
  statusByNode: Record<string, StepStatus>
  selectedId: string | null
  onSelect: (nodeId: string) => void
  onInsertAfter: (nodeId: string) => void
}) {
  const spine = spineOf(graph)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  const titleFor = (node: FlowNode): string => {
    switch (node.type) {
      case 'trigger':
        return 'Trigger'
      case 'agent':
        return node.data.label || agentName(node.data.agentId) || 'Agent step'
      case 'condition':
        return conditionText(node)
      case 'loop':
        return node.data.label || 'For each'
      case 'parallel':
        return node.data.label || 'Parallel branches'
      case 'stop':
        return node.data.label || 'Stop'
    }
  }
  const subtitleFor = (node: FlowNode): string | undefined => {
    switch (node.type) {
      case 'trigger': {
        const type = (node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'
        return type.charAt(0).toUpperCase() + type.slice(1)
      }
      case 'agent':
        return node.data.input || undefined
      case 'loop':
        return `over ${node.data.over} · ${node.data.concurrency ?? 1} at a time`
      case 'parallel':
        return `${node.data.branches.length} branches`
      case 'stop':
        return node.data.reason || undefined
      default:
        return undefined
    }
  }

  const connector = (afterId: string) => (
    <div className="flex flex-col items-center py-1">
      <div className="h-3 w-px bg-border" />
      <button
        type="button"
        onClick={() => onInsertAfter(afterId)}
        aria-label="Insert step"
        className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-1 transition-colors hover:border-indigo-300 hover:text-indigo-600"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="h-3 w-px bg-border" />
    </div>
  )

  let stepNumber = 0
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col">
      {spine.map((node, i) => {
        const isTrigger = node.type === 'trigger'
        if (!isTrigger) stepNumber += 1
        const nestedIds =
          node.type === 'loop'
            ? node.data.body
            : node.type === 'parallel'
              ? node.data.branches.flat()
              : []
        const nested = nestedIds.map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
        return (
          <Fragment key={node.id}>
            <StepCard
              index={isTrigger ? undefined : stepNumber}
              type={node.type}
              title={titleFor(node)}
              subtitle={subtitleFor(node)}
              status={statusByNode[node.id]}
              selected={selectedId === node.id}
              onClick={() => onSelect(node.id)}
            />
            {nested.length > 0 && (
              <div className="ml-8 mt-1 space-y-1 border-l-2 border-dashed border-indigo-200 pl-3 dark:border-indigo-500/30">
                {nested.map((body) => (
                  <StepCard
                    key={body.id}
                    type={body.type}
                    title={titleFor(body)}
                    subtitle={body.type === 'agent' ? body.data.input || undefined : undefined}
                    status={statusByNode[body.id]}
                    selected={selectedId === body.id}
                    onClick={() => onSelect(body.id)}
                  />
                ))}
              </div>
            )}
            {i < spine.length - 1 ? connector(node.id) : null}
          </Fragment>
        )
      })}
      <div className={cn('flex flex-col items-center', spine.length > 0 && 'pt-1')}>
        <div className="h-3 w-px bg-border" />
        <button
          type="button"
          onClick={() => onInsertAfter(spine[spine.length - 1]?.id ?? 'trigger')}
          className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-300 hover:text-indigo-600"
        >
          <Plus className="h-3.5 w-3.5" /> Add step
        </button>
      </div>
    </div>
  )
}
