import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries, withTimeout } from '../action-reliability'

test('flow action reliability clamps retries and timeouts', () => {
  assert.equal(flowActionRetries(8), 5)
  assert.equal(flowActionRetries(-2), 0)
  assert.equal(flowActionRetries('2'), 0)
  assert.equal(flowActionTimeoutMs(10), 1000)
  assert.equal(flowActionTimeoutMs(999999), 120000)
  assert.equal(flowActionTimeoutMs('30'), undefined)
})

test('runWithRetries retries failed attempts before succeeding', async () => {
  let attempts = 0
  const result = await runWithRetries(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('temporary failure')
    return 'ok'
  }, { retries: 2, retryDelayMs: 0 })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withTimeout surfaces the timeout message', async () => {
  await assert.rejects(
    withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 30)), 1, 'tool timed out'),
    /tool timed out/,
  )
})
