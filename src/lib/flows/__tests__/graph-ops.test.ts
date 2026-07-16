import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { diffGraph, applyGraphOps, isEmptyOps } from '../graph-ops'

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'agent', data: { agentId: 'x', input: 'y', ...extra } }) as FlowGraph['nodes'][number]
const edge = (id: string, source: string, target: string) => ({ id, source, target })

const base: FlowGraph = {
  nodes: [{ id: 'trigger', type: 'trigger', data: {} }, node('a'), node('b')],
  edges: [edge('e1', 'trigger', 'a'), edge('e2', 'a', 'b')],
}

test('diffGraph then applyGraphOps round-trips to the target', () => {
  const next: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, node('a', { input: 'changed' }), node('c')],
    edges: [edge('e1', 'trigger', 'a'), edge('e3', 'a', 'c')],
  }
  const ops = diffGraph(base, next)
  assert.deepEqual(applyGraphOps(base, ops), next, 'apply(diff(a,b)) on a equals b')
})

test('diffGraph reports only what changed', () => {
  const next = { ...base, nodes: [...base.nodes, node('c')] }
  const ops = diffGraph(base, next)
  assert.deepEqual(ops.upsertNodes?.map((n) => n.id), ['c'])
  assert.equal(ops.removeNodeIds, undefined)
  assert.equal(ops.upsertEdges, undefined)
})

test('isEmptyOps is true for identical graphs', () => {
  assert.equal(isEmptyOps(diffGraph(base, base)), true)
  assert.equal(isEmptyOps(diffGraph(base, { ...base, nodes: [...base.nodes, node('z')] })), false)
})

test('MERGE: concurrent edits to DIFFERENT nodes both survive (no clobber)', () => {
  // Alice moves node a; her ops are computed vs base.
  const aliceNext: FlowGraph = { ...base, nodes: base.nodes.map((n) => (n.id === 'a' ? node('a', { moved: true }) : n)) }
  const aliceOps = diffGraph(base, aliceNext)
  // Bob (still on base) edits node b, then receives Alice's ops.
  const bobLocal: FlowGraph = { ...base, nodes: base.nodes.map((n) => (n.id === 'b' ? node('b', { edited: true }) : n)) }
  const merged = applyGraphOps(bobLocal, aliceOps)
  const a = merged.nodes.find((n) => n.id === 'a')!
  const b = merged.nodes.find((n) => n.id === 'b')!
  assert.equal((a.data as { moved?: boolean }).moved, true, "Alice's move to a is applied")
  assert.equal((b.data as { edited?: boolean }).edited, true, "Bob's edit to b is preserved")
})

test('MERGE preserves existing order; new entities append', () => {
  const ops = { upsertNodes: [node('a', { input: 'z' }), node('new')] }
  const merged = applyGraphOps(base, ops)
  assert.deepEqual(merged.nodes.map((n) => n.id), ['trigger', 'a', 'b', 'new'])
  assert.equal((merged.nodes.find((n) => n.id === 'a')!.data as { input: string }).input, 'z')
})

test('removes drop by id and never resurrect', () => {
  const ops = { removeNodeIds: ['b'], removeEdgeIds: ['e2'] }
  const merged = applyGraphOps(base, ops)
  assert.ok(!merged.nodes.some((n) => n.id === 'b'))
  assert.ok(!merged.edges.some((e) => e.id === 'e2'))
})
