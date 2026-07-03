import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '../memory-store'
import type { GraphNode } from '../store'

function node(id: string, org: string, type: GraphNode['type'], embedding: number[], text = id): GraphNode {
  return { id, organizationId: org, type, text, props: {}, embedding }
}

test('search returns top-k by similarity, scoped to the org', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    node('a', 'org1', 'signal', [1, 0]),
    node('b', 'org1', 'signal', [0.9, 0.1]),
    node('c', 'org1', 'signal', [0, 1]),
    node('x', 'org2', 'signal', [1, 0]), // other org — must not appear
  ])
  const hits = await store.search('org1', [1, 0], 2)
  assert.deepEqual(hits.map((h) => h.node.id), ['a', 'b'])
  assert.ok(!hits.some((h) => h.node.organizationId === 'org2'))
})

test('expand walks edges undirected and excludes the seeds', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    node('signal1', 'org1', 'signal', [1, 0]),
    node('run1', 'org1', 'run', [0, 1]),
    node('agent1', 'org1', 'agent', [0.5, 0.5]),
    node('acct1', 'org1', 'account', [0.2, 0.2]),
  ])
  await store.upsertEdges([
    { organizationId: 'org1', from: 'signal1', to: 'run1', rel: 'triggered_run' },
    { organizationId: 'org1', from: 'run1', to: 'agent1', rel: 'ran_agent' },
    { organizationId: 'org1', from: 'signal1', to: 'acct1', rel: 'about_account' },
  ])
  // 1 hop from signal1 → run1 + acct1 (not agent1, which is 2 hops)
  const oneHop = await store.expand('org1', ['signal1'], 1)
  assert.deepEqual(oneHop.map((n) => n.id).sort(), ['acct1', 'run1'])
  // 2 hops reaches agent1 too
  const twoHop = await store.expand('org1', ['signal1'], 2)
  assert.deepEqual(twoHop.map((n) => n.id).sort(), ['acct1', 'agent1', 'run1'])
})

test('upsert is idempotent for nodes and edges', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0], 'first')])
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0], 'updated')])
  const hits = await store.search('org1', [1, 0], 5)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, 'updated')

  await store.upsertNodes([node('b', 'org1', 'run', [0, 1])])
  await store.upsertEdges([{ organizationId: 'org1', from: 'a', to: 'b', rel: 'triggered_run' }])
  await store.upsertEdges([{ organizationId: 'org1', from: 'a', to: 'b', rel: 'triggered_run' }])
  const neighbors = await store.expand('org1', ['a'], 1)
  assert.deepEqual(neighbors.map((n) => n.id), ['b'])
})

test('clear removes only the target org', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0]), node('b', 'org2', 'signal', [1, 0])])
  await store.clear('org1')
  assert.equal((await store.search('org1', [1, 0], 5)).length, 0)
  assert.equal((await store.search('org2', [1, 0], 5)).length, 1)
})
