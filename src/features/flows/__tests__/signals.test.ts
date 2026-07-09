import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowListensTo, signalDepthOf, SIGNAL_DEPTH_CAP } from '../signals'

const listening = { status: 'ACTIVE', publishedGraph: { nodes: [] }, trigger: { type: 'signal', signal: 'flow.completed' } }

test('flowListensTo matches only active, published, name-matched signal flows', () => {
  assert.equal(flowListensTo(listening, 'flow.completed'), true)
  assert.equal(flowListensTo({ ...listening, trigger: { type: 'signal', signal: 'other' } }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, status: 'DRAFT' }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, publishedGraph: null }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, trigger: { type: 'webhook' } }, 'flow.completed'), false)
  assert.equal(flowListensTo({ ...listening, trigger: 'garbage' }, 'flow.completed'), false)
})

test('signalDepthOf reads run-trigger depth with a 0 default and the cap is 3', () => {
  assert.equal(signalDepthOf({ type: 'signal', signal: 'x', depth: 2 }), 2)
  assert.equal(signalDepthOf({ type: 'manual' }), 0)
  assert.equal(signalDepthOf(null), 0)
  assert.equal(SIGNAL_DEPTH_CAP, 3)
})
