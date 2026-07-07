import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUsageExemptEmail } from '../budget'

test('the platform admin is usage-exempt (case-insensitive)', () => {
  assert.equal(isUsageExemptEmail('james.mcdaniel@people.ai'), true)
  assert.equal(isUsageExemptEmail('James.McDaniel@People.ai'), true)
})

test('other accounts are not exempt', () => {
  assert.equal(isUsageExemptEmail('someone@example.com'), false)
  assert.equal(isUsageExemptEmail(null), false)
  assert.equal(isUsageExemptEmail(undefined), false)
})
