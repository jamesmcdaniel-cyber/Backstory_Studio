import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRunWaiting } from '../run-waiting'

test('returns null for non-waiting runs even if a step is waiting', () => {
  assert.equal(deriveRunWaiting('succeeded', [{ nodeId: 'a', status: 'waiting' }]), null)
  assert.equal(deriveRunWaiting('failed', []), null)
  assert.equal(deriveRunWaiting('running', [{ nodeId: 'a', status: 'running' }]), null)
})

test('returns null when a waiting run has no waiting step', () => {
  assert.equal(deriveRunWaiting('waiting', [{ nodeId: 'a', status: 'succeeded' }]), null)
})

test('derives an input pause with its question', () => {
  const steps = [
    { nodeId: 'a', status: 'succeeded', output: 'done' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'Which account?' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'Which account?' })
})

test('derives an approval pause', () => {
  const steps = [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'approval', approvalId: 'ap_1' } } }]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'approval', question: undefined })
})

test('defaults to input when the waiting info is missing or malformed', () => {
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: null }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: 'a summary string' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'bogus' } } }]), { nodeId: 'b', kind: 'input', question: undefined })
})

test('picks the first waiting step', () => {
  const steps = [
    { nodeId: 'a', status: 'waiting', output: { waiting: { kind: 'approval' } } },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'q' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'a', kind: 'approval', question: undefined })
})
