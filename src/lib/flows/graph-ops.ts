import type { FlowGraph, FlowNode, FlowEdge } from '@/lib/flows/graph'

/**
 * A minimal change-set between two graph states, keyed by id. Broadcasting these
 * instead of the whole graph is what makes live co-editing merge at node/edge
 * granularity: two people editing DIFFERENT nodes no longer clobber each other
 * (their ops apply independently), only concurrent edits to the SAME node
 * contend — and each op is tiny, so large graphs never blow the message size.
 */
export type GraphOps = {
  upsertNodes?: FlowNode[]
  removeNodeIds?: string[]
  upsertEdges?: FlowEdge[]
  removeEdgeIds?: string[]
}

/** Stable-enough identity for change detection. Nodes/edges are built with a
 *  consistent key order, so JSON compare is reliable; a false "changed" only
 *  causes a harmless idempotent re-upsert. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The ops that transform `prev` into `next` (added/changed/removed by id). */
export function diffGraph(prev: FlowGraph, next: FlowGraph): GraphOps {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodeIds = new Set(next.nodes.map((n) => n.id))
  const upsertNodes = next.nodes.filter((n) => !same(prevNodes.get(n.id), n))
  const removeNodeIds = prev.nodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => n.id)

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]))
  const nextEdgeIds = new Set(next.edges.map((e) => e.id))
  const upsertEdges = next.edges.filter((e) => !same(prevEdges.get(e.id), e))
  const removeEdgeIds = prev.edges.filter((e) => !nextEdgeIds.has(e.id)).map((e) => e.id)

  const ops: GraphOps = {}
  if (upsertNodes.length) ops.upsertNodes = upsertNodes
  if (removeNodeIds.length) ops.removeNodeIds = removeNodeIds
  if (upsertEdges.length) ops.upsertEdges = upsertEdges
  if (removeEdgeIds.length) ops.removeEdgeIds = removeEdgeIds
  return ops
}

/** True when a diff carries no changes (nothing to broadcast). */
export function isEmptyOps(ops: GraphOps): boolean {
  return !ops.upsertNodes?.length && !ops.removeNodeIds?.length && !ops.upsertEdges?.length && !ops.removeEdgeIds?.length
}

/**
 * Merge ops into a graph, preserving the current node/edge ORDER for entities
 * that survive (so the canvas doesn't reshuffle on a remote edit), appending
 * genuinely-new entities at the end. Upserts win by id; removes drop by id.
 */
export function applyGraphOps(graph: FlowGraph, ops: GraphOps): FlowGraph {
  const upsertNode = new Map((ops.upsertNodes ?? []).map((n) => [n.id, n]))
  const removeNode = new Set(ops.removeNodeIds ?? [])
  const nodes: FlowNode[] = []
  const seenNode = new Set<string>()
  for (const n of graph.nodes) {
    if (removeNode.has(n.id)) continue
    seenNode.add(n.id)
    nodes.push(upsertNode.get(n.id) ?? n)
  }
  for (const n of ops.upsertNodes ?? []) if (!seenNode.has(n.id) && !removeNode.has(n.id)) nodes.push(n)

  const upsertEdge = new Map((ops.upsertEdges ?? []).map((e) => [e.id, e]))
  const removeEdge = new Set(ops.removeEdgeIds ?? [])
  const edges: FlowEdge[] = []
  const seenEdge = new Set<string>()
  for (const e of graph.edges) {
    if (removeEdge.has(e.id)) continue
    seenEdge.add(e.id)
    edges.push(upsertEdge.get(e.id) ?? e)
  }
  for (const e of ops.upsertEdges ?? []) if (!seenEdge.has(e.id) && !removeEdge.has(e.id)) edges.push(e)

  return { nodes, edges }
}
