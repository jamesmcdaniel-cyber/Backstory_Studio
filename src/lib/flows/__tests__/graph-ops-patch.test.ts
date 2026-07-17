import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffGraph, applyGraphOps, isEmptyOps } from '../graph-ops'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const node = (id: string, data: Record<string, unknown>, type = 'agent'): FlowNode =>
  ({ id, type, data } as unknown as FlowNode)
const g = (...nodes: FlowNode[]): FlowGraph => ({ nodes, edges: [] })

test('a data-field change emits a patch, not a full upsert', () => {
  const prev = g(node('a', { agentId: '1', label: 'Old' }))
  const next = g(node('a', { agentId: '1', label: 'New' }))
  const ops = diffGraph(prev, next)
  assert.equal(ops.upsertNodes, undefined)
  assert.deepEqual(ops.patchNodes, [{ id: 'a', set: { label: 'New' } }])
  assert.equal(isEmptyOps(ops), false)
})

test('round-trip: applying the diff reproduces the target graph', () => {
  const prev = g(node('a', { agentId: '1', label: 'Old', note: 'gone' }))
  const next = g(node('a', { agentId: '2', label: 'Old' }))
  assert.deepEqual(applyGraphOps(prev, diffGraph(prev, next)), next)
})

test('concurrent edits to DIFFERENT fields of the same node both survive', () => {
  const base = g(node('a', { agentId: '1', label: 'A' }))
  const opsLabel = diffGraph(base, g(node('a', { agentId: '1', label: 'B' })))
  const opsAgent = diffGraph(base, g(node('a', { agentId: '2', label: 'A' })))
  const merged = applyGraphOps(applyGraphOps(base, opsLabel), opsAgent)
  assert.deepEqual(merged.nodes[0], node('a', { agentId: '2', label: 'B' }))
})

test('a removed data key travels as unset and is deleted on apply', () => {
  const prev = g(node('a', { agentId: '1', note: 'temp' }))
  const next = g(node('a', { agentId: '1' }))
  const ops = diffGraph(prev, next)
  assert.deepEqual(ops.patchNodes, [{ id: 'a', unset: ['note'] }])
  assert.deepEqual(applyGraphOps(prev, ops), next)
})

test('a type change falls back to a full upsert', () => {
  const prev = g(node('a', { agentId: '1' }, 'agent'))
  const next = g(node('a', { url: 'https://x', method: 'GET' }, 'http'))
  const ops = diffGraph(prev, next)
  assert.equal(ops.patchNodes, undefined)
  assert.equal(ops.upsertNodes?.length, 1)
})

test('a patch for a locally-deleted node is a no-op (delete wins)', () => {
  const base = g(node('a', { agentId: '1', label: 'A' }), node('b', { agentId: '2' }))
  const patchA = diffGraph(base, g(node('a', { agentId: '1', label: 'B' }), node('b', { agentId: '2' })))
  const localWithoutA = g(node('b', { agentId: '2' }))
  const merged = applyGraphOps(localWithoutA, patchA)
  assert.deepEqual(merged.nodes.map((n) => n.id), ['b'], 'patch must not resurrect a deleted node')
})
