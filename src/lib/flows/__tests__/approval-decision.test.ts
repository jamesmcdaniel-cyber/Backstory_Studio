import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseApprovalDecision, shouldConsumeApprovalDecision } from '../approval-decision'

test('parseApprovalDecision parses a decision reply object', () => {
  const reply = JSON.stringify({ status: 'approved', approvalId: 'ap_1', executed: true, result: { ok: true } })
  assert.deepEqual(parseApprovalDecision(reply), { status: 'approved', approvalId: 'ap_1', executed: true, result: { ok: true } })
})

test('parseApprovalDecision parses a rejected decision reply', () => {
  const parsed = parseApprovalDecision(JSON.stringify({ status: 'rejected', approvalId: 'ap_2', message: 'no' }))
  assert.equal(parsed?.status, 'rejected')
  assert.equal(parsed?.approvalId, 'ap_2')
})

test('parseApprovalDecision returns null for free text', () => {
  assert.equal(parseApprovalDecision('yes please go ahead'), null)
})

test('parseApprovalDecision returns null for non-object JSON', () => {
  assert.equal(parseApprovalDecision('"approved"'), null)
  assert.equal(parseApprovalDecision('42'), null)
  assert.equal(parseApprovalDecision('null'), null)
  assert.equal(parseApprovalDecision('["approved"]'), null)
})

test('shouldConsumeApprovalDecision consumes only a correlated approvalId', () => {
  const paused = new Set(['ap_1'])
  assert.equal(shouldConsumeApprovalDecision({ status: 'approved', approvalId: 'ap_1' }, paused), true)
  assert.equal(shouldConsumeApprovalDecision({ status: 'rejected', approvalId: 'ap_1' }, paused), true)
})

test('shouldConsumeApprovalDecision refuses a mismatched approvalId', () => {
  const paused = new Set(['ap_1'])
  assert.equal(shouldConsumeApprovalDecision({ status: 'approved', approvalId: 'ap_OTHER' }, paused), false)
})

test('shouldConsumeApprovalDecision refuses a decision without an approvalId', () => {
  const paused = new Set(['ap_1'])
  assert.equal(shouldConsumeApprovalDecision({ status: 'approved' }, paused), false)
  assert.equal(shouldConsumeApprovalDecision(null, paused), false)
})

test('shouldConsumeApprovalDecision refuses non-decision statuses', () => {
  const paused = new Set(['ap_1'])
  assert.equal(shouldConsumeApprovalDecision({ status: 'pending', approvalId: 'ap_1' }, paused), false)
  assert.equal(shouldConsumeApprovalDecision({ approvalId: 'ap_1' }, paused), false)
})

test('consume-once: deleting the consumed id stops a second consume (loop items)', () => {
  // Mirrors the executor: item 0 consumes its decision and deletes the id;
  // item 1 (same node, resume=true) must NOT also consume it — it falls
  // through and queues its own approval instead.
  const paused = new Set(['ap_1'])
  const decision = parseApprovalDecision(JSON.stringify({ status: 'approved', approvalId: 'ap_1', executed: true }))
  assert.equal(shouldConsumeApprovalDecision(decision, paused), true)
  paused.delete(String(decision?.approvalId))
  assert.equal(shouldConsumeApprovalDecision(decision, paused), false)
})
