import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyInputDefaults, missingRequiredInputFields } from '../input-validation'

const FIELDS = [
  { name: 'account', default: 'Acme' },
  { name: 'priority', default: 'normal' },
  { name: 'note' }, // no default
]

test('fills a field from its default when no value is provided', () => {
  const merged = applyInputDefaults(FIELDS, { note: 'hello' })
  assert.deepEqual(merged, { note: 'hello', account: 'Acme', priority: 'normal' })
})

test('an explicit provided value overrides the field default', () => {
  const merged = applyInputDefaults(FIELDS, { account: 'Globex' }) as Record<string, unknown>
  assert.equal(merged.account, 'Globex')
})

test('a blank empty-string value is replaced by the default', () => {
  const merged = applyInputDefaults(FIELDS, { account: '' }) as Record<string, unknown>
  assert.equal(merged.account, 'Acme')
})

test('a field with no default stays absent when it is missing', () => {
  const merged = applyInputDefaults(FIELDS, {}) as Record<string, unknown>
  assert.equal('note' in merged, false)
  assert.equal(merged.account, 'Acme')
})

test('bare string input is returned unchanged (defaults are structured-only)', () => {
  assert.equal(applyInputDefaults(FIELDS, 'just text'), 'just text')
})

test('non-object inputs (null / undefined / array) pass through untouched', () => {
  assert.equal(applyInputDefaults(FIELDS, null), null)
  assert.equal(applyInputDefaults(FIELDS, undefined), undefined)
  const arr = ['a']
  assert.equal(applyInputDefaults(FIELDS, arr), arr)
})

test('does not mutate the input argument', () => {
  const input = { note: 'hello' }
  const merged = applyInputDefaults(FIELDS, input)
  assert.deepEqual(input, { note: 'hello' })
  assert.notEqual(merged, input)
})

test('false and 0 are real values and are not overwritten by a default', () => {
  const fields = [{ name: 'flag', default: 'true' }, { name: 'n', default: '5' }]
  const merged = applyInputDefaults(fields, { flag: false, n: 0 }) as Record<string, unknown>
  assert.equal(merged.flag, false)
  assert.equal(merged.n, 0)
})

test('an empty-string default does not fill (nothing meaningful to apply)', () => {
  const merged = applyInputDefaults([{ name: 'x', default: '' }], {}) as Record<string, unknown>
  assert.equal('x' in merged, false)
})

test('a required field with a default is satisfied after applyInputDefaults', () => {
  const declared = [{ name: 'account', type: 'string' as const, required: true, default: 'Acme' }]
  const filled = applyInputDefaults(declared, {})
  assert.deepEqual(missingRequiredInputFields(declared, filled), [])
})

test('a required field with neither value nor default is still missing', () => {
  const declared = [{ name: 'account', type: 'string' as const, required: true }]
  const filled = applyInputDefaults(declared, {})
  assert.deepEqual(missingRequiredInputFields(declared, filled), ['account'])
})
