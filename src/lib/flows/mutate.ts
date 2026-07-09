import { flowNodeSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'

/** Node types a user can create as a step (everything but the trigger). */
export type StepType = Exclude<FlowNode['type'], 'trigger'>

/** Generate a node id not already used in the graph. */
function newNodeId(graph: FlowGraph, prefix = 'n'): string {
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  while (ids.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function edgeId(source: string, target: string, branch?: string): string {
  return `${source}->${target}${branch ? `:${branch}` : ''}`
}

/** Default `data` for a freshly created / retyped node. */
function defaultData(type: FlowNode['type'], extra?: { bodyId?: string; agentId?: string }): FlowNode['data'] {
  switch (type) {
    case 'agent':
      return { agentId: extra?.agentId ?? '', input: 'Use this flow input:\n{{trigger.input}}' }
    case 'condition':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'loop':
      return { over: '{{trigger.input}}', concurrency: 3, body: extra?.bodyId ? [extra.bodyId] : [] }
    case 'parallel':
      return { branches: extra?.bodyId ? [[extra.bodyId]] : [] }
    case 'stop':
      return { reason: '' }
    case 'tool':
      return { connectionId: '', toolName: '', args: '{}' }
    case 'http':
      return { method: 'POST', url: '', bodyMode: 'json', responseType: 'auto', failOnHttpError: true, retries: 0, body: '' }
    case 'transform':
      return { fields: [{ name: '', value: '' }] }
    case 'filter':
      return { match: 'all', clauses: [{ left: '', op: 'contains', right: '' }] }
    case 'switch':
      return { cases: [{ id: 'case1', left: '', op: 'contains', right: '' }] }
    case 'trigger':
      return { trigger: { type: 'manual' } }
  }
}

function makeNode(graph: FlowGraph, type: StepType, agentId?: string): { node: FlowNode; extraNodes: FlowNode[] } {
  const id = newNodeId(graph)
  // Containers are born with one agent body step so they are runnable.
  if (type === 'loop' || type === 'parallel') {
    const bodyId = `${id}b1`
    const body = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: agentId ?? '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    return { node: { id, type, data: defaultData(type, { bodyId }) } as FlowNode, extraNodes: [body] }
  }
  return { node: { id, type, data: defaultData(type, { agentId }) } as FlowNode, extraNodes: [] }
}

/** Insert a new step of any type immediately after `afterId`, healing the chain. */
export function insertNodeAfter(graph: FlowGraph, afterId: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const edges = [...graph.edges]
  // Reconnect afterId's primary outgoing edge through the new node.
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(node.id, old.target), source: node.id, target: old.target }
  }
  edges.push({ id: edgeId(afterId, node.id), source: afterId, target: node.id })
  return { graph: { nodes: [...graph.nodes, node, ...extraNodes], edges }, nodeId: node.id }
}

/** Back-compat helper used by earlier tests: insert an agent step. */
export function insertAgentAfter(graph: FlowGraph, afterId: string, agentId: string): { graph: FlowGraph; nodeId: string } {
  return insertNodeAfter(graph, afterId, 'agent', agentId)
}

/**
 * Append a step to a condition's true/false branch: at the tail of the existing
 * branch chain, or as the branch's first node when the branch is empty.
 */
export function appendToBranch(graph: FlowGraph, conditionId: string, branch: string, type: StepType, agentId?: string): { graph: FlowGraph; nodeId: string } {
  const head = graph.edges.find((edge) => edge.source === conditionId && edge.branch === branch)
  if (!head) {
    const { node, extraNodes } = makeNode(graph, type, agentId)
    return {
      graph: {
        nodes: [...graph.nodes, node, ...extraNodes],
        edges: [...graph.edges, { id: edgeId(conditionId, node.id, branch), source: conditionId, target: node.id, branch }],
      },
      nodeId: node.id,
    }
  }
  // Walk to the branch tail (cycle-guarded), then do a plain insert after it.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  let tail = head.target
  while (!seen.has(tail)) {
    seen.add(tail)
    const next = graph.edges.find((edge) => edge.source === tail && !edge.branch)
    if (!next || !byId.has(next.target)) break
    tail = next.target
  }
  return insertNodeAfter(graph, tail, type, agentId)
}

/** Replace a node (matched by id) with an updated version. */
export function updateNode(graph: FlowGraph, updated: FlowNode): FlowGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === updated.id ? updated : node)) }
}

/** Change a node's type, resetting its data. Containers get a body agent step. */
export function changeNodeType(graph: FlowGraph, id: string, type: StepType): FlowGraph {
  if (type === 'loop' || type === 'parallel') {
    const bodyId = newNodeId(graph, 'b')
    const bodyNode = {
      id: bodyId,
      type: 'agent',
      data: {
        agentId: '',
        input: type === 'loop' ? 'Process this item:\n{{item}}' : 'Use this flow input:\n{{trigger.input}}',
      },
    } as FlowNode
    const nodes = graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type, { bodyId }) } as FlowNode) : node))
    return { ...graph, nodes: [...nodes, bodyNode] }
  }
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type) } as FlowNode) : node)) }
}

/** Append a new typed step to a loop body or a new parallel branch. */
export function addContainerStep(graph: FlowGraph, containerId: string, type: StepType = 'agent', agentId?: string): { graph: FlowGraph; nodeId: string } {
  const container = graph.nodes.find((n) => n.id === containerId)
  const isLoop = container?.type === 'loop'
  const { node, extraNodes } = makeNode(graph, type, agentId)
  const bodyNode =
    node.type === 'agent' && isLoop
      ? ({ ...node, data: { ...node.data, input: 'Process this item:\n{{item}}' } } as FlowNode)
      : node
  const nodes = graph.nodes.map((node) => {
    if (node.id !== containerId) return node
    if (node.type === 'loop') return { ...node, data: { ...node.data, body: [...node.data.body, bodyNode.id] } }
    if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [...node.data.branches, [bodyNode.id]] } }
    return node
  })
  return { graph: { ...graph, nodes: [...nodes, bodyNode, ...extraNodes] }, nodeId: bodyNode.id }
}

/** Duplicate a step in place: the copy is inserted right after the original. */
export function duplicateNode(graph: FlowGraph, id: string): { graph: FlowGraph; nodeId: string } {
  const original = graph.nodes.find((node) => node.id === id)
  if (!original || original.type === 'trigger') return { graph, nodeId: id }
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: original.type, data: JSON.parse(JSON.stringify(original.data)) } as FlowNode
  // Containers duplicate shallowly (fresh empty body) — bodies keep their ids
  // and must not be shared between two containers.
  if (copy.type === 'loop') copy.data = { ...copy.data, body: [] }
  if (copy.type === 'parallel') copy.data = { ...copy.data, branches: [] }
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === id && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(id, copyId), source: id, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}

/**
 * Delete a node, healing the chain: its predecessor connects to its successor,
 * preserving the incoming edge's branch flag (so deleting the first node of a
 * condition branch keeps the branch wired).
 */
export function deleteNode(graph: FlowGraph, id: string): FlowGraph {
  if (id === 'trigger') return graph
  const incoming = graph.edges.find((edge) => edge.target === id)
  const outgoing = graph.edges.find((edge) => edge.source === id && !edge.branch)
  const edges = graph.edges.filter((edge) => edge.source !== id && edge.target !== id)
  if (incoming && outgoing) {
    edges.push({ id: edgeId(incoming.source, outgoing.target, incoming.branch), source: incoming.source, target: outgoing.target, ...(incoming.branch ? { branch: incoming.branch } : {}) })
  }
  const nodes = graph.nodes
    .filter((node) => node.id !== id)
    // Purge the id from any loop body / parallel branches that referenced it.
    .map((node) => {
      if (node.type === 'loop') return { ...node, data: { ...node.data, body: node.data.body.filter((b) => b !== id) } }
      if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: node.data.branches.map((br) => br.filter((b) => b !== id)) } }
      return node
    })
  return { nodes, edges }
}

/** Ids living inside a container node's own subtree (its body/branch steps). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  return []
}

/**
 * Move an existing step so it sits immediately after `afterId`, healing both
 * the old and new positions. Container bodies are NOT movable this way — use
 * moveContainerStep. No-op on any invalid move.
 */
export function moveNodeAfter(graph: FlowGraph, nodeId: string, afterId: string): FlowGraph {
  if (nodeId === afterId || nodeId === 'trigger') return graph
  const node = graph.nodes.find((n) => n.id === nodeId)
  const target = graph.nodes.find((n) => n.id === afterId)
  if (!node || !target) return graph
  if (containedIdsOf(node).includes(afterId)) return graph
  // A step referenced by any container's body/branches moves via the array API.
  const contained = new Set(graph.nodes.flatMap(containedIdsOf))
  if (contained.has(nodeId)) return graph

  // 1) Detach: heal the chain around the node (deleteNode's edge logic, node kept).
  const incoming = graph.edges.find((edge) => edge.target === nodeId)
  const outgoing = graph.edges.find((edge) => edge.source === nodeId && !edge.branch)
  let edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  // Branch edges leaving a condition/switch node being moved stay with it —
  // conditions/switches carry their branch heads, so keep those edges intact.
  const branchEdges = graph.edges.filter((edge) => edge.source === nodeId && edge.branch)
  edges = [...edges, ...branchEdges]
  if (incoming && outgoing) {
    edges.push({
      id: edgeId(incoming.source, outgoing.target, incoming.branch),
      source: incoming.source,
      target: outgoing.target,
      ...(incoming.branch ? { branch: incoming.branch } : {}),
    })
  }

  // 2) Splice after the target (insertNodeAfter's edge logic, existing node).
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(nodeId, old.target), source: nodeId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, nodeId), source: afterId, target: nodeId })
  return { ...graph, edges }
}

/** Reorder a loop body (or one parallel branch) by index. Out-of-range no-ops. */
export function moveContainerStep(graph: FlowGraph, containerId: string, from: number, to: number, branchIndex?: number): FlowGraph {
  const container = graph.nodes.find((n) => n.id === containerId)
  if (!container) return graph
  const reorder = (list: string[]): string[] | null => {
    if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return null
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  }
  if (container.type === 'loop') {
    const next = reorder(container.data.body)
    if (!next) return graph
    return updateNode(graph, { ...container, data: { ...container.data, body: next } })
  }
  if (container.type === 'parallel' && branchIndex !== undefined) {
    const branch = container.data.branches[branchIndex]
    if (!branch) return graph
    const next = reorder(branch)
    if (!next) return graph
    const branches = container.data.branches.map((b, i) => (i === branchIndex ? next : b))
    return updateNode(graph, { ...container, data: { ...container.data, branches } })
  }
  return graph
}

/** Validate clipboard content into a paste-safe step (never a trigger; containers emptied). */
export function sanitizeCopiedNode(raw: unknown): FlowNode | null {
  const parsed = flowNodeSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type === 'trigger') return null
  const node = parsed.data
  if (node.type === 'loop') return { ...node, data: { ...node.data, body: [] } }
  if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [] } }
  return node
}

/** Paste a sanitized copied step immediately after `afterId` with a fresh id. */
export function pasteNodeAfter(graph: FlowGraph, afterId: string, copied: FlowNode): { graph: FlowGraph; nodeId: string } {
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: copied.type, data: JSON.parse(JSON.stringify(copied.data)) } as FlowNode
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, copyId), source: afterId, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}
