import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowJobOptions } from '../queue-options'

test('flowJobOptions: a resume (flowRunId present) gets a run-scoped jobId and no attempts override', () => {
  const opts = flowJobOptions('run-1', 1000)
  assert.equal(opts.jobId, 'run-1-resume-1000')
  assert.equal(opts.attempts, undefined)
})

test('flowJobOptions: a fresh execution (no flowRunId) gets attempts:1 and no jobId', () => {
  const opts = flowJobOptions(undefined)
  assert.equal(opts.attempts, 1)
  assert.equal(opts.jobId, undefined)
})
