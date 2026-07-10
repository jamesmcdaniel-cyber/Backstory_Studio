import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
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

test('structured trigger input fields are addressable', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'Account {{trigger.input.account.name}} has {{trigger.input.items.0}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, { account: { name: 'Acme' }, items: ['A'] }, { runAgent })
  assert.equal(result.output, 'Account Acme has A')
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

test('loop honors concurrency while preserving output order', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  let active = 0
  let maxActive = 0
  const delays: Record<string, number> = { '0': 30, '1': 5, '2': 10, '3': 1 }
  const runAgent: RunAgentFn = async (node) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, delays[node.input] ?? 1))
    active -= 1
    return { output: node.input }
  }
  const result = await interpretFlow(graph, [0, 1, 2, 3], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(maxActive, 2)
  assert.deepEqual(result.output, ['0', '1', '2', '3'])
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

test('loop accepts comma-separated and newline-separated text input', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.deepEqual((await interpretFlow(graph, 'Acme, Globex', { runAgent })).output, ['Acme', 'Globex'])
  assert.deepEqual((await interpretFlow(graph, 'Acme\nGlobex', { runAgent })).output, ['Acme', 'Globex'])
})

test('loop accepts common object payload lists', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, JSON.stringify({ items: [{ name: 'Acme' }, { name: 'Globex' }] }), { runAgent })
  assert.deepEqual(result.output, ['Acme', 'Globex'])
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

test('resume skips completed nodes and re-runs the paused one', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'ask', input: 'y' } },
      { id: 'n3', type: 'agent', data: { agentId: 'a3', input: 'got {{step.n2.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'n2') return { output: n.resume ? 'ANSWERED' : 'ignored' }
    return { output: n.input }
  }
  // Resume: n1 already completed (skipped), n2 is the paused node (re-runs w/ reply).
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { n1: 'a1' },
    resumeNodeId: 'n2',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['n2', 'n3']) // n1 was skipped, not re-run
  assert.equal(result.output, 'got ANSWERED') // n3 saw the resumed n2 output
})

test('tool and http steps resolve templates and thread output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'lookup', args: '{"account":"{{trigger.input}}"}' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://example.com/hook', body: 'got {{step.t1.output.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'h1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return node.kind === 'tool' ? { output: '{"score":88}' } : { output: `sent:${node.config.body}` }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const result = await interpretFlow(graph, 'Acme', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: 'Acme' }) // template resolved into tool args
  assert.equal(result.output, 'sent:got 88') // http body saw the tool's structured output
})

test('http steps preserve structured query, headers, and body values', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'h1',
        type: 'http',
        data: {
          method: 'POST',
          url: 'https://example.com/accounts/{{trigger.input.accountId}}',
          query: '{"tags": "{{trigger.input.tags}}", "active": "{{trigger.input.active}}"}',
          headers: '{"authorization": "Bearer {{trigger.input.token}}"}',
          bodyMode: 'json',
          responseType: 'json',
          failOnHttpError: false,
          retries: 2,
          timeoutMs: 15000,
          body: '{"record": "{{trigger.input.record}}"}',
        },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: { ok: true } }
  }
  const input = { accountId: 'acct_1', tags: ['a', 'b'], active: true, token: 'tok', record: { name: 'Acme' } }
  const result = await interpretFlow(graph, input, { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: 'https://example.com/accounts/acct_1',
    query: { tags: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer tok' },
    body: { record: { name: 'Acme' } },
    bodyMode: 'json',
    responseType: 'json',
    failOnHttpError: false,
    retries: 2,
    timeoutMs: 15000,
  })
})

test('tool args preserve object values from loop items', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['tool'] } },
      { id: 'tool', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"account": "{{item}}", "name": "{{item.name}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'ok' }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const input = JSON.stringify([{ name: 'Acme', score: 91 }])
  const result = await interpretFlow(graph, input, { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: { name: 'Acme', score: 91 }, name: 'Acme' })
})

test('tool steps pass retry and timeout config to the action runtime', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'tool',
        type: 'tool',
        data: {
          connectionId: 'c1',
          toolName: 'send',
          retries: 2,
          timeoutMs: 15000,
          args: '{"message":"{{trigger.input.message}}"}',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'tool' }],
  }
  const calls: Record<string, unknown>[] = []
  const result = await interpretFlow(graph, { message: 'hello' }, {
    runAgent: async () => ({ output: '' }),
    runAction: async (node) => {
      calls.push(node.config)
      return { output: { ok: true } }
    },
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    connectionId: 'c1',
    toolName: 'send',
    args: { message: 'hello' },
    retries: 2,
    timeoutMs: 15000,
  })
})

test('a failing tool step honors onError', async () => {
  const graph = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'boom', onError } },
      { id: 'a1', type: 'agent', data: { agentId: 'ok', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'a1' },
    ],
  })
  const runAction: RunActionFn = async () => ({ error: 'tool exploded' })
  const runAgent: RunAgentFn = async () => ({ output: 'OK' })
  assert.equal((await interpretFlow(graph('stop'), '', { runAgent, runAction })).status, 'failed')
  assert.equal((await interpretFlow(graph('continue'), '', { runAgent, runAction })).output, 'OK')
})

test('transform builds an object from templated fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a', input: 'x' } },
      { id: 'set', type: 'transform', data: { fields: [{ name: 'account', value: '{{trigger.input}}' }, { name: 'score', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }, { id: 'e1', source: 'n1', target: 'set' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: '{"score":91}' })
  const result = await interpretFlow(graph, 'Acme', { runAgent })
  assert.deepEqual(result.output, { account: 'Acme', score: 91 })
})

test('filter drops loop items that fail and ends the chain when it fails', async () => {
  const loopGraph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['keep', 'echo'] } },
      { id: 'keep', type: 'filter', data: { clauses: [{ left: '{{item.score}}', op: 'gt', right: '80' }] } },
      { id: 'echo', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const items = [{ name: 'A', score: 91 }, { name: 'B', score: 40 }, { name: 'C', score: 88 }]
  const result = await interpretFlow(loopGraph, items, { runAgent })
  assert.deepEqual(result.output, ['A', 'C']) // B (score 40) filtered out
})

test('switch routes to the matching case, else default', async () => {
  const graph = (_tier: string): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'ent', left: '{{trigger.input}}', op: 'eq', right: 'enterprise' }, { id: 'mid', left: '{{trigger.input}}', op: 'eq', right: 'mid' }] } },
      { id: 'e', type: 'agent', data: { agentId: 'ent', input: 'ENT' } },
      { id: 'm', type: 'agent', data: { agentId: 'mid', input: 'MID' } },
      { id: 'd', type: 'agent', data: { agentId: 'def', input: 'DEFAULT' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'e', branch: 'ent' },
      { id: 'e2', source: 'sw', target: 'm', branch: 'mid' },
      { id: 'e3', source: 'sw', target: 'd', branch: 'default' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.equal((await interpretFlow(graph('enterprise'), 'enterprise', { runAgent })).output, 'ENT')
  assert.equal((await interpretFlow(graph('mid'), 'mid', { runAgent })).output, 'MID')
  assert.equal((await interpretFlow(graph('smb'), 'smb', { runAgent })).output, 'DEFAULT')
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

test('structured agent steps append the JSON instruction and expose parsed fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          input: 'Score this account',
          responseFormat: 'structured',
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
      { id: 'n2', type: 'transform', data: { fields: [{ name: 'finalScore', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
    ],
  }
  let sentInput = ''
  const runAgent: RunAgentFn = async (node) => {
    sentInput = node.input
    return { output: '{"score": 91}' }
  }
  const result = await interpretFlow(graph, 'acme', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.match(sentInput, /JSON object/)
  assert.match(sentInput, /"score"/)
  assert.deepEqual(result.output, { finalScore: 91 })
})

test('structured agent steps fail when the reply is not the required JSON', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: { agentId: 'a1', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: 'no json here' })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /JSON/)
})

test('humanAssistance=false turns a waiting agent into a failed step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', humanAssistance: false } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.steps.find((s) => s.nodeId === 'n1')?.status, 'failed')
})

test('humanAssistance defaults to allowing the pause', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'n1')
})

test('an agent timeout fails the step without starting a second concurrent execution', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 3, timeoutMs: 1000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  // Never resolves: simulates a live execution that outruns the step timeout.
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return new Promise(() => {})
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1) // retries: 3 must NOT re-run the still-live agent
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /Timed out after 1s — the agent may still be finishing in the background\./)
})

test('agent hard errors still retry up to the configured budget', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 1, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return calls < 2 ? { error: 'boom' } : { output: 'recovered' }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 2)
  assert.equal(result.output, 'recovered')
})
