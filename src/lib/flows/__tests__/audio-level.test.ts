import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmsLevel, SPEAKING_THRESHOLD } from '../audio-level'

test('silence (all 128) is 0; a loud square wave approaches 1', () => {
  assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0)
  const loud = new Uint8Array(64)
  for (let i = 0; i < loud.length; i++) loud[i] = i % 2 ? 255 : 0
  assert.ok(rmsLevel(loud) > 0.9)
})

test('empty buffer is 0 and threshold is sane', () => {
  assert.equal(rmsLevel(new Uint8Array(0)), 0)
  assert.ok(SPEAKING_THRESHOLD > 0 && SPEAKING_THRESHOLD < 0.5)
})
