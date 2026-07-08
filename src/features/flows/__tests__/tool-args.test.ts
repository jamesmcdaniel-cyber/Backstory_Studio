import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareToolArgs } from '../tool-args'

test('prepareToolArgs accepts objects and JSON object strings', () => {
  assert.deepEqual(prepareToolArgs({ account: 'Acme' }), { account: 'Acme' })
  assert.deepEqual(prepareToolArgs('{"account":"Acme"}'), { account: 'Acme' })
  assert.deepEqual(prepareToolArgs(undefined), {})
})

test('prepareToolArgs rejects invalid JSON and non-object JSON values', () => {
  assert.throws(() => prepareToolArgs('{bad'), /not valid JSON/)
  assert.throws(() => prepareToolArgs('[]'), /JSON object/)
  assert.throws(() => prepareToolArgs('"text"'), /JSON object/)
  assert.throws(() => prepareToolArgs(['not', 'object']), /JSON object/)
})
