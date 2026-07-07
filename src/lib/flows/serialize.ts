import type { FlowGraph } from '@/lib/flows/graph'

/** Wire shape for a flow, shared by the list page and the builder. */
export function serializeFlow(flow: {
  id: string
  name: string
  description: string
  status: string
  trigger: unknown
  graph: unknown
  visibility: string
  createdAt: Date
  updatedAt: Date
}) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  const stepCount = (graph.nodes || []).filter((node) => node.type === 'agent').length
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status.toLowerCase(),
    trigger: flow.trigger ?? { type: 'manual' },
    graph,
    visibility: flow.visibility,
    stepCount,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
