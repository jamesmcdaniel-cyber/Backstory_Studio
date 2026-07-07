import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/** Generate a node id not already used in the graph. */
function newNodeId(graph: FlowGraph, prefix = 'n'): string {
  const ids = new Set(graph.nodes.map((node) => node.id))
  let index = graph.nodes.length + 1
  while (ids.has(`${prefix}${index}`)) index += 1
  return `${prefix}${index}`
}

function edgeId(source: string, target: string, branch?: 'true' | 'false'): string {
  return `${source}->${target}${branch ? `:${branch}` : ''}`
}

/** Default `data` for a freshly created / retyped node. */
function defaultData(type: FlowNode['type'], bodyId?: string): FlowNode['data'] {
  switch (type) {
    case 'agent':
      return { agentId: '', input: '{{trigger.input}}' }
    case 'condition':
      return { left: '', op: 'contains', right: '' }
    case 'loop':
      return { over: '{{trigger.input}}', concurrency: 3, body: bodyId ? [bodyId] : [] }
    case 'parallel':
      return { branches: [] }
    case 'trigger':
      return { trigger: { type: 'manual' } }
  }
}

/** Insert a new agent step immediately after `afterId`, healing the chain. */
export function insertAgentAfter(graph: FlowGraph, afterId: string, agentId: string): { graph: FlowGraph; nodeId: string } {
  const id = newNodeId(graph)
  const node = { id, type: 'agent', data: { agentId, input: '{{trigger.input}}' } } as FlowNode
  const edges = [...graph.edges]
  // Reconnect afterId's primary outgoing edge through the new node.
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(id, old.target), source: id, target: old.target }
  }
  edges.push({ id: edgeId(afterId, id), source: afterId, target: id })
  return { graph: { nodes: [...graph.nodes, node], edges }, nodeId: id }
}

/** Replace a node (matched by id) with an updated version. */
export function updateNode(graph: FlowGraph, updated: FlowNode): FlowGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === updated.id ? updated : node)) }
}

/** Change a node's type, resetting its data. Loops get a fresh body agent node. */
export function changeNodeType(graph: FlowGraph, id: string, type: FlowNode['type']): FlowGraph {
  if (type === 'loop') {
    const bodyId = newNodeId(graph, 'b')
    const bodyNode = { id: bodyId, type: 'agent', data: { agentId: '', input: '{{item}}' } } as FlowNode
    const nodes = graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type, bodyId) } as FlowNode) : node))
    return { ...graph, nodes: [...nodes, bodyNode] }
  }
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? ({ id, type, data: defaultData(type) } as FlowNode) : node)) }
}

/** Delete a node, healing the chain (its predecessor connects to its successor). */
export function deleteNode(graph: FlowGraph, id: string): FlowGraph {
  if (id === 'trigger') return graph
  const incoming = graph.edges.find((edge) => edge.target === id && !edge.branch)
  const outgoing = graph.edges.find((edge) => edge.source === id && !edge.branch)
  const edges = graph.edges.filter((edge) => edge.source !== id && edge.target !== id)
  if (incoming && outgoing) edges.push({ id: edgeId(incoming.source, outgoing.target), source: incoming.source, target: outgoing.target })
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
