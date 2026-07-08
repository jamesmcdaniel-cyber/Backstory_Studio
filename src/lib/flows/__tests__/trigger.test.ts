import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { preserveWebhookSecretHash, triggerFromGraph } from '../trigger'

test('triggerFromGraph extracts the editable trigger from the trigger node', () => {
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00' }, input: '{"team":"sales"}' } },
      },
    ],
    edges: [],
  }
  assert.deepEqual(triggerFromGraph(graph), {
    type: 'schedule',
    schedule: { type: 'daily', time: '09:00' },
    input: '{"team":"sales"}',
  })
})

test('triggerFromGraph falls back to the existing runtime trigger for legacy graphs', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }
  assert.deepEqual(triggerFromGraph(graph, { type: 'webhook', webhookSecretHash: 'hash' }), {
    type: 'webhook',
    webhookSecretHash: 'hash',
  })
})

test('triggerFromGraph normalizes missing or invalid trigger types to manual', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'mystery', foo: true } } }],
    edges: [],
  }
  assert.deepEqual(triggerFromGraph(graph), { type: 'manual', foo: true })
})

test('preserveWebhookSecretHash keeps the existing secret across trigger edits', () => {
  assert.deepEqual(
    preserveWebhookSecretHash({ type: 'manual' }, { type: 'webhook', webhookSecretHash: 'hash' }),
    { type: 'manual', webhookSecretHash: 'hash' },
  )
})
