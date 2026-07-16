import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isUsageExemptEmail, tokenLimitForTier } from '../budget'

test('the platform admin is usage-exempt (case-insensitive)', () => {
  assert.equal(isUsageExemptEmail('james.mcdaniel@people.ai'), true)
  assert.equal(isUsageExemptEmail('James.McDaniel@People.ai'), true)
})

test('other accounts are not exempt', () => {
  assert.equal(isUsageExemptEmail('someone@example.com'), false)
  assert.equal(isUsageExemptEmail(null), false)
  assert.equal(isUsageExemptEmail(undefined), false)
})

const ENV = 'AGENT_MONTHLY_TOKEN_LIMIT'
const prevEnv = process.env[ENV]
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = prevEnv
})

test('no tier and no env override → a non-zero default floor (enforcement on by default)', () => {
  delete process.env[ENV]
  assert.ok(tokenLimitForTier(undefined) > 0, 'unset must NOT mean unlimited')
  assert.ok(tokenLimitForTier(null) > 0)
})

test('a known tier limit is used when there is no env override', () => {
  delete process.env[ENV]
  assert.equal(tokenLimitForTier('sales_ai'), 20_000_000)
})

test('an explicit env value wins, including 0 = unlimited (the documented opt-out)', () => {
  process.env[ENV] = '0'
  assert.equal(tokenLimitForTier(undefined), 0, 'explicit 0 opts back into unlimited')
  assert.equal(tokenLimitForTier('sales_ai'), 0, 'explicit 0 overrides even a tier')
  process.env[ENV] = '5000000'
  assert.equal(tokenLimitForTier(undefined), 5_000_000)
})

test('when both env and tier are set, the more permissive ceiling wins', () => {
  process.env[ENV] = '5000000'
  assert.equal(tokenLimitForTier('sales_ai'), 20_000_000, 'tier (20M) > env (5M)')
  process.env[ENV] = '50000000'
  assert.equal(tokenLimitForTier('sales_ai'), 50_000_000, 'env (50M) > tier (20M)')
})

test('a blank/garbage env value falls through to the default floor, not unlimited', () => {
  process.env[ENV] = '   '
  assert.ok(tokenLimitForTier(undefined) > 0)
  process.env[ENV] = 'not-a-number'
  assert.ok(tokenLimitForTier(undefined) > 0)
})
