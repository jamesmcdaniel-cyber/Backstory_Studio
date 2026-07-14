import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateMeter } from '../gate-meter'

test('gateMeter counts up to the gate and flips message on meeting it', () => {
  assert.deepEqual(gateMeter(0, 3), { percent: 0, label: '0 of 3 tools connected', meetsGate: false })
  assert.deepEqual(gateMeter(2, 3), { percent: 67, label: '2 of 3 tools connected', meetsGate: false })
  assert.equal(gateMeter(3, 3).meetsGate, true)
  assert.match(gateMeter(3, 3).label, /learning/i)
  assert.equal(gateMeter(5, 3).percent, 100)
  assert.equal(gateMeter(-1, 3).percent, 0)
  assert.equal(gateMeter(1, 0).meetsGate, true)
})
