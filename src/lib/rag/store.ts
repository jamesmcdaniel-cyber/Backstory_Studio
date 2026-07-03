/**
 * Graph-RAG store abstraction.
 *
 * The platform's data is a graph: signals reference accounts/opportunities/
 * stakeholders; agents produce runs; runs reference signals; People.ai account
 * facts hang off accounts. This interface stores those as embedded nodes +
 * typed edges and supports the two graph-RAG operations: vector `search`
 * (find semantically relevant nodes) and `expand` (walk edges to gather the
 * connected neighborhood). Every operation is organization-scoped.
 *
 * Implementations: `MemoryGraphStore` (tests, local dev, and a working default
 * when no external store is configured) and `Neo4jGraphStore` (production).
 */

export type NodeType =
  | 'account'
  | 'opportunity'
  | 'stakeholder'
  | 'signal'
  | 'agent'
  | 'run'
  | 'insight'

export interface GraphNode {
  id: string
  organizationId: string
  type: NodeType
  /** Human-readable text that was embedded (title/summary/body). */
  text: string
  /** Structured attributes rendered into context (dates, amounts, status, url). */
  props: Record<string, unknown>
  embedding: number[]
  updatedAt?: string
}

export type EdgeRelation =
  | 'about_account'
  | 'about_opportunity'
  | 'about_stakeholder'
  | 'triggered_run'
  | 'ran_agent'
  | 'belongs_to' // opportunity/stakeholder → account

export interface GraphEdge {
  organizationId: string
  from: string
  to: string
  rel: EdgeRelation
}

export interface SearchHit {
  node: GraphNode
  score: number
}

export interface GraphRagStore {
  upsertNodes(nodes: GraphNode[]): Promise<void>
  upsertEdges(edges: GraphEdge[]): Promise<void>
  /** Vector search within an org; returns top-k by cosine similarity. */
  search(organizationId: string, queryEmbedding: number[], k: number): Promise<SearchHit[]>
  /** Neighborhood expansion: nodes reachable from `nodeIds` within `hops` edges. */
  expand(organizationId: string, nodeIds: string[], hops: number): Promise<GraphNode[]>
  /** For tests/cleanup. */
  clear?(organizationId: string): Promise<void>
}
