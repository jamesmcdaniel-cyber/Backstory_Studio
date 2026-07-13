import type { FlowEdge, FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * "Make Subflow" (WS18): turn a contiguous run of main-chain steps into a new
 * flow, and replace them in the parent with a single `subflow` step. Pure
 * planning/rewriting only — creating the child flow (and learning its id) is
 * the caller's job, so extraction is two-phase:
 *
 *   1. `planSubflowExtraction(graph, startId, endId)` → the child graph to
 *      create, the input token the parent should send, and the range ids.
 *   2. `replaceRangeWithSubflow(graph, plan, childFlowId, name)` → the parent
 *      graph with the range swapped for a wired subflow step.
 *
 * v1 token-safety contract (refused with a plain-English error otherwise):
 * the range may reference its own steps, `{{trigger.input*}}`, and at most
 * ONE step outside the range. Outside-step references are rewritten to
 * `{{trigger.input*}}` in the child, and the parent sends that step's output
 * as the child's input — so the extracted steps see identical data.
 */

export type SubflowExtractionPlan = {
  /** Every node moving into the child: the range plus container bodies. */
  rangeIds: string[]
  childGraph: FlowGraph
  /** What the parent's subflow step sends as input ('' = nothing needed). */
  childInput: string
  startId: string
  endId: string
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Main-chain successor (the only unlabeled outgoing edge's target). */
function nextOf(graph: FlowGraph, id: string): string | null {
  const edge = graph.edges.find((e) => e.source === id && !e.branch)
  return edge ? edge.target : null
}

/** Node ids living inside a container node (loop body / parallel branches). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  return []
}

function collectTokenPaths(value: unknown, paths: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN_RE)) paths.push(match[1])
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTokenPaths(entry, paths)
    return
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectTokenPaths(entry, paths)
  }
}

function rewriteTokens(value: unknown, rewrite: (path: string) => string): unknown {
  if (typeof value === 'string') {
    return value.replace(TOKEN_RE, (_whole, path: string) => `{{${rewrite(path)}}}`)
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteTokens(entry, rewrite))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteTokens(entry, rewrite)]))
  }
  return value
}

export function planSubflowExtraction(
  graph: FlowGraph,
  startId: string,
  endId: string,
): SubflowExtractionPlan | { error: string } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const start = byId.get(startId)
  const end = byId.get(endId)
  if (!start || !end) return { error: 'Pick steps that are still on the canvas.' }
  if (start.type === 'trigger' || end.type === 'trigger') return { error: 'The trigger cannot move into a subflow.' }

  const containedAnywhere = new Set(graph.nodes.flatMap(containedIdsOf))
  if (containedAnywhere.has(startId) || containedAnywhere.has(endId)) {
    return { error: 'Steps inside a For each or Parallel container cannot be extracted — extract the whole container instead.' }
  }

  // Walk the main chain start → end; that walk IS the range.
  const chain: string[] = []
  let cursor: string | null = startId
  const guard = new Set<string>()
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor)
    chain.push(cursor)
    if (cursor === endId) break
    cursor = nextOf(graph, cursor)
  }
  if (chain[chain.length - 1] !== endId) {
    return { error: 'The end step must come after the start step on the same path.' }
  }

  const chainNodes = chain.map((id) => byId.get(id)!).filter(Boolean)
  const branching = chainNodes.find((node) => node.type === 'condition' || node.type === 'switch' || node.type === 'join')
  if (branching) {
    return { error: 'Branching steps (If/else, Switch, Join) cannot move into a subflow yet — select a straight run of steps.' }
  }

  // The subtree: chain + container bodies riding along.
  const rangeIds = new Set(chain)
  for (const node of chainNodes) for (const id of containedIdsOf(node)) rangeIds.add(id)

  // Token safety: scan every moved node's data for references leaving the range.
  const outsideSteps = new Set<string>()
  for (const id of rangeIds) {
    const node = byId.get(id)
    if (!node) continue
    const paths: string[] = []
    collectTokenPaths(node.data, paths)
    for (const path of paths) {
      const parts = path.split('.')
      if (parts[0] === 'step' && parts[1] && !rangeIds.has(parts[1])) outsideSteps.add(parts[1])
      if (parts[0] === 'var') {
        return { error: 'These steps use a variable — variables are flow-wide and cannot move into a subflow yet.' }
      }
    }
  }
  // {{item}}/{{loop.*}} at the top level would mean we're inside a loop body;
  // top-level main-chain nodes never legally reference them, and in-range
  // containers keep their own item scope — so no extra check needed here.
  if (outsideSteps.size > 1) {
    const labels = Array.from(outsideSteps).join(', ')
    return { error: `These steps read from more than one earlier step (${labels}) — a subflow can receive only one input. Combine them first (e.g. with a Compose step).` }
  }

  const outside = Array.from(outsideSteps)[0]
  const rewrite = (path: string): string => {
    if (!outside) return path
    const parts = path.split('.')
    if (parts[0] === 'step' && parts[1] === outside && parts[2] === 'output') {
      return ['trigger', 'input', ...parts.slice(3)].join('.')
    }
    return path
  }

  const childNodes: FlowNode[] = [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } } as FlowNode,
    ...Array.from(rangeIds).map((id) => {
      const node = byId.get(id)!
      return { ...node, data: rewriteTokens(node.data, rewrite) } as FlowNode
    }),
  ]
  const childEdges: FlowEdge[] = [
    { id: `trigger->${startId}`, source: 'trigger', target: startId },
    // Every edge fully inside the range comes along (incl. container-adjacent).
    ...graph.edges.filter((edge) => rangeIds.has(edge.source) && rangeIds.has(edge.target)),
  ]

  return {
    rangeIds: Array.from(rangeIds),
    childGraph: { nodes: childNodes, edges: childEdges },
    childInput: outside ? `{{step.${outside}.output}}` : '{{trigger.input}}',
    startId,
    endId,
  }
}

/** Swap the planned range for a subflow step pointing at the created child. */
export function replaceRangeWithSubflow(
  graph: FlowGraph,
  plan: SubflowExtractionPlan,
  childFlowId: string,
  childName: string,
): { graph: FlowGraph; nodeId: string } {
  const range = new Set(plan.rangeIds)
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  while (ids.has(`n${index}`)) index += 1
  const nodeId = `n${index}`

  const inbound = graph.edges.filter((edge) => !range.has(edge.source) && edge.target === plan.startId)
  const outboundNext = nextOf(graph, plan.endId)

  const nodes = graph.nodes.filter((node) => !range.has(node.id))
  const edges: FlowEdge[] = graph.edges.filter((edge) => !range.has(edge.source) && !range.has(edge.target))
  for (const edge of inbound) {
    edges.push({ ...edge, id: `${edge.source}->${nodeId}${edge.branch ? `:${edge.branch}` : ''}`, target: nodeId })
  }
  if (outboundNext && !range.has(outboundNext)) {
    edges.push({ id: `${nodeId}->${outboundNext}`, source: nodeId, target: outboundNext })
  }

  const subflowNode = {
    id: nodeId,
    type: 'subflow',
    data: { flowId: childFlowId, input: plan.childInput, label: childName },
  } as FlowNode

  return { graph: { nodes: [...nodes, subflowNode], edges }, nodeId }
}
