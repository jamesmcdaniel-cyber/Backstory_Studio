import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowToolOutput } from '../tool-output'

test('flowToolOutput preserves structuredContent as direct workflow output', () => {
  assert.deepEqual(flowToolOutput({
    structuredContent: { id: 'acct_1', score: 92 },
    content: [{ type: 'text', text: 'Account acct_1' }],
  }), { id: 'acct_1', score: 92 })
})

test('flowToolOutput parses JSON text content and top-level JSON strings', () => {
  assert.deepEqual(flowToolOutput({ content: [{ type: 'text', text: '{"ok":true,"items":[1,2]}' }] }), {
    ok: true,
    items: [1, 2],
  })
  assert.deepEqual(flowToolOutput('{"ok":true}'), { ok: true })
})

test('flowToolOutput returns plain text content and fails MCP error results', () => {
  assert.equal(flowToolOutput({ content: [{ type: 'text', text: 'sent to Slack' }] }), 'sent to Slack')
  assert.throws(() => flowToolOutput({ isError: true, content: [{ type: 'text', text: 'Slack rejected the message' }] }), /Slack rejected/)
})
