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
  patchNodes?: NodePatch[]
  upsertEdges?: FlowEdge[]
  removeEdgeIds?: string[]
}

/** Per-field patch of one node's `data` — the field-level merge unit. Two
 *  people editing DIFFERENT fields of the SAME node no longer clobber each
 *  other; only the same field stays last-write-wins. */
export type NodePatch = { id: string; set?: Record<string, unknown>; unset?: string[] }

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
  const upsertNodes: FlowNode[] = []
  const patchNodes: NodePatch[] = []
  for (const n of next.nodes) {
    const before = prevNodes.get(n.id)
    if (!before) { upsertNodes.push(n); continue }                 // new node
    if (same(before, n)) continue                                   // unchanged
    if (before.type !== n.type) { upsertNodes.push(n); continue }   // retype = atomic
    // Same node, same type: diff data at field granularity so concurrent
    // edits to different fields of one node merge instead of clobbering.
    const prevData = before.data as Record<string, unknown>
    const nextData = n.data as Record<string, unknown>
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const key of Object.keys(nextData)) if (!same(prevData[key], nextData[key])) set[key] = nextData[key]
    for (const key of Object.keys(prevData)) if (!(key in nextData)) unset.push(key)
    if (Object.keys(set).length || unset.length) {
      patchNodes.push({ id: n.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) })
    } else {
      upsertNodes.push(n) // changed outside data (defensive) — send whole node
    }
  }
  const removeNodeIds = prev.nodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => n.id)

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]))
  const nextEdgeIds = new Set(next.edges.map((e) => e.id))
  const upsertEdges = next.edges.filter((e) => !same(prevEdges.get(e.id), e))
  const removeEdgeIds = prev.edges.filter((e) => !nextEdgeIds.has(e.id)).map((e) => e.id)

  const ops: GraphOps = {}
  if (upsertNodes.length) ops.upsertNodes = upsertNodes
  if (removeNodeIds.length) ops.removeNodeIds = removeNodeIds
  if (patchNodes.length) ops.patchNodes = patchNodes
  if (upsertEdges.length) ops.upsertEdges = upsertEdges
  if (removeEdgeIds.length) ops.removeEdgeIds = removeEdgeIds
  return ops
}

/** True when a diff carries no changes (nothing to broadcast). */
export function isEmptyOps(ops: GraphOps): boolean {
  return (
    !ops.upsertNodes?.length && !ops.removeNodeIds?.length && !ops.patchNodes?.length &&
    !ops.upsertEdges?.length && !ops.removeEdgeIds?.length
  )
}

/**
 * Merge ops into a graph, preserving the current node/edge ORDER for entities
 * that survive (so the canvas doesn't reshuffle on a remote edit), appending
 * genuinely-new entities at the end. Upserts win by id; removes drop by id.
 */
export function applyGraphOps(graph: FlowGraph, ops: GraphOps): FlowGraph {
  const upsertNode = new Map((ops.upsertNodes ?? []).map((n) => [n.id, n]))
  const patchNode = new Map((ops.patchNodes ?? []).map((p) => [p.id, p]))
  const removeNode = new Set(ops.removeNodeIds ?? [])
  const nodes: FlowNode[] = []
  const seenNode = new Set<string>()
  for (const n of graph.nodes) {
    if (removeNode.has(n.id)) continue
    seenNode.add(n.id)
    const upserted = upsertNode.get(n.id)
    if (upserted) { nodes.push(upserted); continue }
    const patch = patchNode.get(n.id)
    if (patch) {
      // Field-level merge: our other fields survive a teammate's edit.
      const data = { ...(n.data as Record<string, unknown>), ...(patch.set ?? {}) }
      for (const key of patch.unset ?? []) delete data[key]
      nodes.push({ ...n, data } as FlowNode)
      continue
    }
    nodes.push(n)
  }
  for (const n of ops.upsertNodes ?? []) if (!seenNode.has(n.id) && !removeNode.has(n.id)) nodes.push(n)
  // Patches for nodes absent locally are deliberately dropped — a concurrent
  // delete wins over a field edit.

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
