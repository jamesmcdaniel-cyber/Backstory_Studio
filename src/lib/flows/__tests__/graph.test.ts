import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph, triggerInputFieldSchema } from '../graph'

test('emptyGraph has a single manual trigger node and no edges', () => {
  const g = emptyGraph()
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].type, 'trigger')
  assert.deepEqual(g.edges, [])
})

test('flowGraphSchema accepts a valid agent+condition graph', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { inputFields: [{ name: 'account', type: 'string', description: 'Customer name.' }] } } },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'condition', data: { left: '{{step.n1.output}}', op: 'contains', right: 'yes' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  assert.equal(parsed.nodes.length, 3)
  const trigger = parsed.nodes.find((node) => node.type === 'trigger')
  assert.deepEqual(trigger?.data.trigger.inputFields[0], { name: 'account', type: 'string', description: 'Customer name.' })
})

test('flowGraphSchema allows agent timeouts up to 20 minutes', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}', timeoutMs: 1_200_000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  assert.equal(flowGraphSchema.parse(graph).nodes[1].type, 'agent')
  assert.throws(() =>
    flowGraphSchema.parse({
      ...graph,
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}', timeoutMs: 1_200_001 } },
      ],
    }),
  )
})

test('flowGraphSchema rejects an unknown node type', () => {
  assert.throws(() => flowGraphSchema.parse({ nodes: [{ id: 'x', type: 'webhook', data: {} }], edges: [] }))
})

test('flowGraphSchema rejects a condition with a bad op', () => {
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [{ id: 'c', type: 'condition', data: { left: 'a', op: 'startsWith', right: 'b' } }],
      edges: [],
    }),
  )
})

test('triggerInputFieldSchema accepts a required flag', () => {
  const parsed = triggerInputFieldSchema.parse({ name: 'account', type: 'string', required: true })
  assert.equal(parsed.required, true)
  assert.equal(triggerInputFieldSchema.parse({ name: 'note', type: 'string' }).required, undefined)
})

test('agent nodes accept responseFormat and humanAssistance', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          responseFormat: 'structured',
          humanAssistance: false,
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  const agent = graph.nodes[1]
  assert.equal(agent.type, 'agent')
  if (agent.type === 'agent') {
    assert.equal(agent.data.responseFormat, 'structured')
    assert.equal(agent.data.humanAssistance, false)
  }
})
