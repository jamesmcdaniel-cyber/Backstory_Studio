import type { FlowGraph } from '@/lib/flows/graph'
import { canEditFlow } from '@/lib/flows/access'

/** Wire shape for a flow, shared by the list page and the builder. */
export function serializeFlow(flow: {
  id: string
  name: string
  description: string
  status: string
  trigger: unknown
  graph: unknown
  publishedGraph?: unknown
  version?: number
  visibility: string
  folder?: string
  userId?: string | null
  createdAt: Date
  updatedAt: Date
}, viewerId?: string) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  const stepCount = (graph.nodes || []).filter((node) => node.type === 'agent').length
  const published = flow.publishedGraph != null
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status.toLowerCase(),
    trigger: flow.trigger ?? { type: 'manual' },
    graph,
    visibility: flow.visibility,
    // Whether THIS viewer may edit ('view' flows are owner-editable only).
    canEdit: viewerId === undefined ? true : canEditFlow({ visibility: flow.visibility, userId: flow.userId ?? null }, viewerId),
    folder: flow.folder ?? '',
    stepCount,
    version: flow.version ?? 1,
    published,
    // True when the draft differs from what's published (or nothing is published).
    unpublishedChanges: !published || JSON.stringify(flow.publishedGraph) !== JSON.stringify(graph),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
