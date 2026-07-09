import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldStrategize, goalSection, strategizeSection, STRATEGIZE_RETRIEVAL } from '../strategy'

test('shouldStrategize triggers on toggle, long objective, high maxTurns, many tools', () => {
  const base = { objective: 'short', metadata: {}, toolCount: 5 }
  assert.equal(shouldStrategize(base), false)
  assert.equal(shouldStrategize({ ...base, metadata: { alwaysStrategize: true } }), true)
  assert.equal(shouldStrategize({ ...base, objective: 'x'.repeat(1201) }), true)
  assert.equal(shouldStrategize({ ...base, metadata: { maxTurns: 24 } }), true)
  assert.equal(shouldStrategize({ ...base, toolCount: 26 }), true)
})

test('goalSection renders the heading or empty', () => {
  assert.match(goalSection('Grow upsell pipeline'), /^## Larger goal\n/)
  assert.equal(goalSection(null), '')
  assert.equal(goalSection('   '), '')
})

test('strategizeSection demands a numbered plan before tools', () => {
  const section = strategizeSection()
  assert.match(section, /^## Think before acting\n/)
  assert.match(section, /numbered plan/i)
  assert.ok(STRATEGIZE_RETRIEVAL.topK === 10 && STRATEGIZE_RETRIEVAL.hops === 3)
})
