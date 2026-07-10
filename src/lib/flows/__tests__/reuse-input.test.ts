import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldReuseInput, storedRunInput, prefillTextFromRunInput } from '../reuse-input'

test('reuses input when the flow was not edited after the last success started', () => {
  assert.equal(
    shouldReuseInput({
      flowUpdatedAt: new Date('2026-07-01T10:00:00Z'),
      lastSuccessStartedAt: new Date('2026-07-02T10:00:00Z'),
    }),
    true,
  )
})

test('refuses reuse when the flow was edited after the last success started', () => {
  assert.equal(
    shouldReuseInput({
      flowUpdatedAt: new Date('2026-07-03T10:00:00Z'),
      lastSuccessStartedAt: new Date('2026-07-02T10:00:00Z'),
    }),
    false,
  )
})

test('an edit at exactly the run start still allows reuse', () => {
  const at = new Date('2026-07-02T10:00:00Z')
  assert.equal(shouldReuseInput({ flowUpdatedAt: at, lastSuccessStartedAt: at }), true)
})

test('storedRunInput unwraps the { prompt } envelope', () => {
  assert.deepEqual(storedRunInput({ prompt: { account: 'Acme' } }), { account: 'Acme' })
  assert.equal(storedRunInput({ prompt: 'plain text' }), 'plain text')
})

test('storedRunInput passes non-envelope values through', () => {
  assert.deepEqual(storedRunInput({ account: 'Acme' }), { account: 'Acme' })
  assert.equal(storedRunInput('raw'), 'raw')
  assert.equal(storedRunInput(null), null)
})

test('prefill text keeps strings as-is', () => {
  assert.equal(prefillTextFromRunInput({ prompt: 'summarize the account' }), 'summarize the account')
})

test('prefill text pretty-prints structured payloads', () => {
  assert.equal(
    prefillTextFromRunInput({ prompt: { account: 'Acme', count: 3 } }),
    JSON.stringify({ account: 'Acme', count: 3 }, null, 2),
  )
})

test('prefill text is empty for missing input', () => {
  assert.equal(prefillTextFromRunInput(null), '')
  assert.equal(prefillTextFromRunInput({ prompt: null }), '')
})
