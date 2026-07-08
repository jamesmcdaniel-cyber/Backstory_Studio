import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowInputFromWebhookBody, parseFlowInput } from '../input'

test('parseFlowInput preserves text and parses JSON-looking input', () => {
  assert.equal(parseFlowInput('Acme'), 'Acme')
  assert.deepEqual(parseFlowInput('{"account":"Acme"}'), { account: 'Acme' })
  assert.deepEqual(parseFlowInput('[1,2]'), [1, 2])
  assert.equal(parseFlowInput('{not json'), '{not json')
})

test('flowInputFromWebhookBody uses input field when present', () => {
  assert.deepEqual(flowInputFromWebhookBody({ input: { account: 'Acme' }, ignored: true }), { account: 'Acme' })
  assert.deepEqual(flowInputFromWebhookBody({ input: '{"account":"Acme"}' }), { account: 'Acme' })
})

test('flowInputFromWebhookBody falls back to full body', () => {
  assert.deepEqual(flowInputFromWebhookBody({ account: 'Acme' }), { account: 'Acme' })
  assert.equal(flowInputFromWebhookBody('plain text'), 'plain text')
})
