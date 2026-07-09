import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingRequiredInputFields } from '../input-validation'

const FIELDS = [
  { name: 'account', type: 'string' as const, required: true },
  { name: 'priority', type: 'string' as const, required: false },
  { name: 'count', type: 'number' as const, required: true },
]

test('returns empty when nothing is required', () => {
  assert.deepEqual(missingRequiredInputFields([{ name: 'a', type: 'string' as const }], undefined), [])
})

test('reports required fields missing from the payload', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { priority: 'high' }), ['account', 'count'])
})

test('accepts a payload that supplies every required field', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { account: 'Acme', count: 3 }), [])
})

test('treats empty strings and null as missing', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, { account: '  ', count: null }), ['account', 'count'])
})

test('false and 0 count as supplied', () => {
  const fields = [{ name: 'flag', type: 'boolean' as const, required: true }, { name: 'n', type: 'number' as const, required: true }]
  assert.deepEqual(missingRequiredInputFields(fields, { flag: false, n: 0 }), [])
})

test('a non-object input misses every required field', () => {
  assert.deepEqual(missingRequiredInputFields(FIELDS, 'just text'), ['account', 'count'])
})
