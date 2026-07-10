import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { captureError, setErrorReporter, resetErrorReporter, flushErrorReporting, setErrorFlusher } from '../sentry'

beforeEach(() => resetErrorReporter())

test('captureError without a DSN or reporter is a safe no-op', () => {
  delete process.env.SENTRY_DSN
  assert.doesNotThrow(() => captureError(new Error('boom'), { path: '/api/x' }))
})

test('captureError forwards to an injected reporter with context', () => {
  const seen: Array<{ error: unknown; context?: Record<string, unknown> }> = []
  setErrorReporter((error, context) => seen.push({ error, context }))
  const failure = new Error('kaput')
  captureError(failure, { path: '/api/agents' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].error, failure)
  assert.equal(seen[0].context?.path, '/api/agents')
})

test('a throwing reporter never breaks the caller', () => {
  setErrorReporter(() => {
    throw new Error('reporter exploded')
  })
  assert.doesNotThrow(() => captureError(new Error('original')))
})

test('flushErrorReporting is a safe no-op when Sentry was never initialized', async () => {
  await assert.doesNotReject(() => flushErrorReporting())
})

test('flushErrorReporting forwards the timeout to an injected flusher', async () => {
  const calls: number[] = []
  setErrorFlusher(async (timeoutMs) => {
    calls.push(timeoutMs)
  })
  await flushErrorReporting(1234)
  assert.deepEqual(calls, [1234])
})

test('a rejecting flusher never breaks the caller', async () => {
  setErrorFlusher(async () => {
    throw new Error('flush exploded')
  })
  await assert.doesNotReject(() => flushErrorReporting())
})
