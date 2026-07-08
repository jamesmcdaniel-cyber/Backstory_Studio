import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MODEL_TURN_TIMEOUT_MS,
  AGENT_RUN_MAX_DURATION_SECONDS,
  AGENT_RUN_TIMEOUT_MS,
} from '../timeouts'

test('agent execution timeout constants allow 20 minute runs', () => {
  assert.equal(AGENT_RUN_MAX_DURATION_SECONDS, 1200)
  assert.equal(AGENT_RUN_TIMEOUT_MS, 1_200_000)
  assert.equal(AGENT_MODEL_TURN_TIMEOUT_MS, 1_140_000)
})

