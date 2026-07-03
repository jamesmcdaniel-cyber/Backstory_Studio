/**
 * Neo4j GraphRagStore adapter.
 *
 * Nodes are stored as `(:Entity {id, organizationId, type, text, embedding,
 * props, updatedAt})`; edges as typed relationships. Vector search uses a
 * Neo4j vector index when present, falling back to org-scoped cosine scoring.
 * `expand` is a variable-length undirected traversal.
 *
 * The neo4j-driver import is dynamic so the package is only required when
 * NEO4J_* is configured — the app builds and runs without it.
 */

import { cosineSimilarity, EMBEDDING_DIM } from './embeddings'
import type { GraphEdge, GraphNode, GraphRagStore, NodeType, SearchHit } from './store'

const VECTOR_INDEX = 'entity_embedding'

export function neo4jConfigured(): boolean {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD)
}

type Driver = {
  executeQuery: (query: string, params?: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }>
  close: () => Promise<void>
}

export class Neo4jGraphStore implements GraphRagStore {
  private driverPromise: Promise<Driver> | null = null

  private async driver(): Promise<Driver> {
    if (!this.driverPromise) {
      this.driverPromise = (async () => {
        const neo4j = (await import('neo4j-driver')).default
        const driver = neo4j.driver(
          process.env.NEO4J_URI!,
          neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
        ) as unknown as Driver
        await this.ensureIndexes(driver)
        return driver
      })()
    }
    return this.driverPromise
  }

  private async ensureIndexes(driver: Driver): Promise<void> {
    await driver.executeQuery(
      'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
    ).catch(() => undefined)
    await driver.executeQuery(
      `CREATE VECTOR INDEX ${VECTOR_INDEX} IF NOT EXISTS FOR (e:Entity) ON (e.embedding)
       OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine' } }`,
    ).catch(() => undefined)
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return
    const driver = await this.driver()
    await driver.executeQuery(
      `UNWIND $rows AS row
       MERGE (e:Entity { id: row.id })
       SET e.organizationId = row.organizationId, e.type = row.type, e.text = row.text,
           e.props = row.props, e.embedding = row.embedding, e.updatedAt = row.updatedAt`,
      {
        rows: nodes.map((n) => ({
          id: n.id, organizationId: n.organizationId, type: n.type, text: n.text,
          props: JSON.stringify(n.props ?? {}), embedding: n.embedding, updatedAt: n.updatedAt ?? new Date().toISOString(),
        })),
      },
    )
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return
    const driver = await this.driver()
    // Relationship type can't be parameterized; it's from our fixed EdgeRelation
    // union (never user input), so interpolation is safe.
    for (const edge of edges) {
      await driver.executeQuery(
        `MATCH (a:Entity { id: $from }), (b:Entity { id: $to })
         MERGE (a)-[r:${edge.rel.toUpperCase()}]->(b)
         SET r.organizationId = $organizationId`,
        { from: edge.from, to: edge.to, organizationId: edge.organizationId },
      )
    }
  }

  async search(organizationId: string, queryEmbedding: number[], k: number): Promise<SearchHit[]> {
    if (queryEmbedding.length === 0) return []
    const driver = await this.driver()
    // Over-fetch from the vector index, then filter to the org and take k.
    const { records } = await driver.executeQuery(
      `CALL db.index.vector.queryNodes($index, $fetch, $q) YIELD node, score
       WHERE node.organizationId = $org
       RETURN node, score LIMIT $k`,
      { index: VECTOR_INDEX, fetch: Math.max(k * 4, 20), q: queryEmbedding, org: organizationId, k },
    ).catch(async () => {
      // No vector index (e.g. Community edition): fall back to scoring in-app.
      const all = await driver.executeQuery(
        'MATCH (e:Entity { organizationId: $org }) RETURN e AS node',
        { org: organizationId },
      )
      const scored = all.records
        .map((r) => hydrate(r.get('node')))
        .filter((n): n is GraphNode => n !== null && n.embedding.length > 0)
        .map((node) => ({ node, score: cosineSimilarity(queryEmbedding, node.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
      return { records: scored.map((s) => ({ get: (key: string) => (key === 'node' ? toRaw(s.node) : s.score) })) }
    })

    return records
      .map((r) => ({ node: hydrate(r.get('node')), score: Number(r.get('score')) || 0 }))
      .filter((h): h is SearchHit => h.node !== null)
  }

  async expand(organizationId: string, nodeIds: string[], hops: number): Promise<GraphNode[]> {
    if (nodeIds.length === 0) return []
    const driver = await this.driver()
    const { records } = await driver.executeQuery(
      `MATCH (seed:Entity) WHERE seed.id IN $ids
       MATCH (seed)-[*1..${Math.max(1, Math.min(hops, 3))}]-(n:Entity { organizationId: $org })
       WHERE NOT n.id IN $ids
       RETURN DISTINCT n AS node`,
      { ids: nodeIds, org: organizationId },
    )
    return records.map((r) => hydrate(r.get('node'))).filter((n): n is GraphNode => n !== null)
  }
}

function toRaw(node: GraphNode) {
  return { properties: { ...node, props: JSON.stringify(node.props ?? {}) } }
}

/** Convert a driver node record into a GraphNode, tolerating shape differences. */
function hydrate(raw: unknown): GraphNode | null {
  const props = (raw as { properties?: Record<string, unknown> })?.properties ?? (raw as Record<string, unknown>)
  if (!props || typeof props !== 'object') return null
  const p = props as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.organizationId !== 'string') return null
  let parsedProps: Record<string, unknown> = {}
  try {
    parsedProps = typeof p.props === 'string' ? JSON.parse(p.props) : (p.props as Record<string, unknown>) ?? {}
  } catch {
    parsedProps = {}
  }
  return {
    id: p.id,
    organizationId: p.organizationId,
    type: (p.type as NodeType) ?? 'insight',
    text: typeof p.text === 'string' ? p.text : '',
    props: parsedProps,
    embedding: Array.isArray(p.embedding) ? (p.embedding as number[]) : [],
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
  }
}
