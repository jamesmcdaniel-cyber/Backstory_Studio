import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { layoutGraph } from '../layout'

test('layoutGraph places every outer node with left-to-right ranks', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }
  const pos = layoutGraph(graph)
  assert.equal(pos.size, 3)
  // LR: each downstream node sits strictly to the right of its parent.
  assert.ok(pos.get('a')!.x > pos.get('trigger')!.x, 'a is right of trigger')
  assert.ok(pos.get('b')!.x > pos.get('a')!.x, 'b is right of a')
})

test('layoutGraph lays out a fan-in diamond (multiple parents converge)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p1', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'p2', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'j', type: 'agent', data: { agentId: 'x', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'p1' },
      { id: 'e1', source: 'trigger', target: 'p2' },
      { id: 'e2', source: 'p1', target: 'j' },
      { id: 'e3', source: 'p2', target: 'j' },
    ],
  }
  const pos = layoutGraph(graph)
  assert.equal(pos.size, 4)
  // The join sits to the right of both parents; the two parents share a column
  // and are separated vertically.
  assert.ok(pos.get('j')!.x > pos.get('p1')!.x && pos.get('j')!.x > pos.get('p2')!.x)
  assert.notEqual(pos.get('p1')!.y, pos.get('p2')!.y)
})

test('layoutGraph excludes container body nodes (containers are single nodes)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 1, body: ['b1'] } },
      { id: 'b1', type: 'agent', data: { agentId: 'x', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const pos = layoutGraph(graph)
  assert.ok(pos.has('loop'))
  assert.ok(!pos.has('b1'), 'the loop body node is not laid out on the outer canvas')
})

test('layoutGraph honors a persisted position instead of recomputing it', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' }, position: { x: 999, y: 777 } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const pos = layoutGraph(graph)
  assert.deepEqual(pos.get('a'), { x: 999, y: 777 })
})
