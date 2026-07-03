import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProviderAvailabilityError, structuredProviderOrder } from '../model-runner'

test('gpt default prefers openai, falls back to anthropic', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'gpt-4o', openai: true, anthropic: true }),
    ['openai', 'anthropic'],
  )
})

test('claude default prefers anthropic', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'claude-opus-4-8', openai: true, anthropic: true }),
    ['anthropic', 'openai'],
  )
})

test('only configured providers appear', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'gpt-4o', openai: false, anthropic: true }),
    ['anthropic'],
  )
  assert.deepEqual(structuredProviderOrder({ defaultModel: 'gpt-4o', openai: false, anthropic: false }), [])
})

test('quota/auth/overload errors are availability failures; schema errors are not', () => {
  assert.equal(isProviderAvailabilityError({ status: 429 }), true) // quota exhausted
  assert.equal(isProviderAvailabilityError({ status: 401 }), true) // bad key
  assert.equal(isProviderAvailabilityError({ status: 529 }), true) // overloaded
  assert.equal(isProviderAvailabilityError({ status: 400 }), false) // our schema/request bug
  assert.equal(isProviderAvailabilityError(new Error('parse failed')), false)
  assert.equal(isProviderAvailabilityError(null), false)
})
