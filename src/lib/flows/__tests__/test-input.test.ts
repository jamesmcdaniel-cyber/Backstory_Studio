import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OutputField } from '../graph'
import { fieldValuesFromFlowInput, flowInputFromFieldValues } from '../test-input'

const fields: OutputField[] = [
  { name: 'account', type: 'string', description: 'Account name' },
  { name: 'score', type: 'number' },
  { name: 'active', type: 'boolean' },
  { name: 'record', type: 'object' },
  { name: 'items', type: 'array' },
  { name: 'meta', type: 'any' },
]

test('fieldValuesFromFlowInput extracts declared fields from a JSON payload', () => {
  assert.deepEqual(
    fieldValuesFromFlowInput('{"account":"Acme","score":91,"active":true,"record":{"id":1},"items":["a"],"meta":null}', fields),
    {
      account: 'Acme',
      score: '91',
      active: 'true',
      record: '{\n  "id": 1\n}',
      items: '[\n  "a"\n]',
      meta: '',
    },
  )
})

test('fieldValuesFromFlowInput ignores non-object raw input', () => {
  assert.deepEqual(fieldValuesFromFlowInput('Acme', fields), {})
  assert.deepEqual(fieldValuesFromFlowInput('["a"]', fields), {})
})

test('flowInputFromFieldValues coerces field form values into a JSON payload', () => {
  const payload = flowInputFromFieldValues(fields, {
    account: 'Acme',
    score: '91',
    active: 'false',
    record: '{"id":1}',
    items: '["a","b"]',
    meta: '{"source":"manual"}',
  })
  assert.deepEqual(JSON.parse(payload), {
    account: 'Acme',
    score: 91,
    active: false,
    record: { id: 1 },
    items: ['a', 'b'],
    meta: { source: 'manual' },
  })
})

test('flowInputFromFieldValues skips blank fields and preserves invalid object text', () => {
  const payload = flowInputFromFieldValues(fields, {
    account: '',
    record: '{"partial"',
  })
  assert.deepEqual(JSON.parse(payload), { record: '{"partial"' })
})
