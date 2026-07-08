import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpOutputFields, outputFieldsFromJsonSchema } from '../schema-fields'

test('outputFieldsFromJsonSchema converts top-level object properties to flow fields', () => {
  const fields = outputFieldsFromJsonSchema({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Record id' },
      score: { type: 'integer' },
      tags: { type: 'array' },
      metadata: { type: 'object' },
    },
  })
  assert.deepEqual(fields, [
    { name: 'id', type: 'string', description: 'Record id' },
    { name: 'score', type: 'number' },
    { name: 'tags', type: 'array' },
    { name: 'metadata', type: 'object' },
  ])
})

test('outputFieldsFromJsonSchema ignores schemas without object properties and bounds field count', () => {
  assert.deepEqual(outputFieldsFromJsonSchema({ type: 'array' }), [])
  assert.deepEqual(outputFieldsFromJsonSchema({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  }, 2), [
    { name: 'a', type: 'string' },
    { name: 'b', type: 'string' },
  ])
})

test('httpOutputFields exposes the stable HTTP response envelope', () => {
  const fields = httpOutputFields()
  assert.deepEqual(fields.map((field) => field.name), ['ok', 'status', 'statusText', 'url', 'headers', 'body', 'bodyText'])
  assert.equal(fields.find((field) => field.name === 'status')?.type, 'number')
  assert.equal(fields.find((field) => field.name === 'body')?.type, 'any')

  fields[0].name = 'mutated'
  assert.equal(httpOutputFields()[0].name, 'ok')
})
