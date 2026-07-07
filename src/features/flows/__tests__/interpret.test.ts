import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// A runAgent stub that echoes a canned output per agentId (default: echoes input).
const stub =
  (map: Record<string, unknown>): RunAgentFn =>
  async (node) => ({ output: map[node.agentId] ?? `ran:${node.input}` })

test('linear flow threads output between two agent steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.n1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: stub({ a1: 'ONE' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got ONE')
  assert.equal(result.steps.filter((s) => s.status === 'succeeded').length, 2)
})

test('condition routes to the true branch', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
      { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.output, 'HIGH')
})

test('loop fans out over an array and collects results', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'loop', type: 'loop', data: { over: '{{step.list.output}}', concurrency: 2, body: ['score'] } },
      { id: 'score', type: 'agent', data: { agentId: 'score', input: 'score {{item}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'loop' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["A","B","C"]' }) })
  // The `score` agent isn't in the stub map, so it echoes `ran:<input>`, which
  // confirms the loop resolved `score {{item}}` per item before delegating.
  assert.deepEqual(result.output, ['ran:score A', 'ran:score B', 'ran:score C'])
})

test('waiting sub-run halts the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'ask', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_for_input', question: 'Which segment?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.question, 'Which segment?')
})

test('onError:stop fails the flow; onError:continue proceeds', async () => {
  const base = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'boom', input: 'x', onError } },
      { id: 'n2', type: 'agent', data: { agentId: 'ok', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: 'DONE' })
  assert.equal((await interpretFlow(base('stop'), '', { runAgent })).status, 'failed')
  assert.equal((await interpretFlow(base('continue'), '', { runAgent })).output, 'DONE')
})

test('stop node ends the flow early and skips later steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 's', type: 'stop', data: { reason: 'done' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 's' },
      { id: 'e2', source: 's', target: 'n2' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (n) => { seen.push(n.agentId); return { output: n.agentId } }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, ['a1']) // a2 never runs
  assert.equal(result.output, 'a1')
})

test('nested loops fan out at two levels', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'outer', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['inner'] } },
      { id: 'inner', type: 'loop', data: { over: '{{item}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: 'v={{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'outer' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, [[1, 2], [3, 4]], { runAgent })
  assert.deepEqual(result.output, [['v=1', 'v=2'], ['v=3', 'v=4']])
})

test('loop exposes {{loop.index}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{loop.index}}:{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, ['a', 'b', 'c'], { runAgent })
  assert.deepEqual(result.output, ['0:a', '1:b', '2:c'])
})

test('an error inside a loop item propagates and fails the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['boom'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: '{{item}}', onError: 'stop' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async () => ({ error: 'kaboom' })
  const result = await interpretFlow(graph, ['a', 'b'], { runAgent })
  assert.equal(result.status, 'failed')
})

test('multi-criteria condition (AND) routes correctly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      {
        id: 'c',
        type: 'condition',
        data: {
          match: 'all',
          clauses: [
            { left: '{{step.n1.output.score}}', op: 'gt', right: '80' },
            { left: '{{trigger.input}}', op: 'contains', right: 'Acme' },
          ],
        },
      },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.agentId === 'score' ? '{"score":91}' : n.agentId.toUpperCase() })
  const result = await interpretFlow(graph, 'Acme Corp', { runAgent })
  assert.equal(result.output, 'HIGH')
})

test('onStep reports every node including containers', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const outcomes: string[] = []
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  await interpretFlow(graph, ['a', 'b'], { runAgent, onStep: (o) => outcomes.push(o.nodeId) })
  assert.ok(outcomes.includes('loop')) // the container itself is reported
  assert.equal(outcomes.filter((id) => id === 'e').length, 2) // one per item
})
