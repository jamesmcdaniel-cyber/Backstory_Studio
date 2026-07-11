import { test } from 'node:test'
import assert from 'node:assert/strict'
import { triggerConditionPasses } from '../trigger-condition'

test('no condition → always passes', () => {
  assert.equal(triggerConditionPasses({ type: 'webhook' }, { status: 'anything' }), true)
})

test('condition gates on the incoming payload', () => {
  const trigger = { type: 'webhook', condition: { match: 'all', clauses: [{ left: '{{trigger.input.status}}', op: 'eq', right: 'urgent' }] } }
  assert.equal(triggerConditionPasses(trigger, { status: 'urgent' }), true)
  assert.equal(triggerConditionPasses(trigger, { status: 'low' }), false)
})

test('a malformed condition fails closed (skips the run), never throws', () => {
  // non-array clauses and a non-string operand both make evalClause throw;
  // the gate must swallow that and return false, not propagate.
  assert.equal(triggerConditionPasses({ type: 'webhook', condition: { clauses: 'nope' } } as never, { status: 'x' }), false)
  assert.equal(triggerConditionPasses({ type: 'webhook', condition: { clauses: [{ left: 5, op: 'eq', right: 'x' }] } } as never, { status: 'x' }), false)
})

test('match:any passes when one clause holds', () => {
  const trigger = { type: 'webhook', condition: { match: 'any', clauses: [
    { left: '{{trigger.input.a}}', op: 'eq', right: '1' },
    { left: '{{trigger.input.b}}', op: 'eq', right: '2' },
  ] } }
  assert.equal(triggerConditionPasses(trigger, { a: '9', b: '2' }), true)
  assert.equal(triggerConditionPasses(trigger, { a: '9', b: '9' }), false)
})
