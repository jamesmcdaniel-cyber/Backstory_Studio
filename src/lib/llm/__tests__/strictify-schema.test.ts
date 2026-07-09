import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strictifySchema } from '../model-runner'

test('top-level object with properties gains additionalProperties:false', () => {
  const out = strictifySchema({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  })
  assert.equal(out.additionalProperties, false)
})

test('nested object (array items) with properties gains the flag', () => {
  const out = strictifySchema({
    type: 'object',
    properties: {
      learnings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, content: { type: 'string' } },
          required: ['title', 'content'],
        },
      },
    },
    required: ['learnings'],
  })
  const learnings = (out.properties as Record<string, unknown>).learnings as Record<string, unknown>
  const items = learnings.items as Record<string, unknown>
  assert.equal(out.additionalProperties, false, 'top-level object gains the flag')
  assert.equal(items.additionalProperties, false, 'nested items object gains the flag')
})

test('deeply nested object (property of a property) gains the flag', () => {
  const out = strictifySchema({
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            meta: {
              type: 'object',
              properties: { actionType: { type: 'string' } },
              required: ['actionType'],
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['suggestions'],
  })
  const suggestions = (out.properties as Record<string, unknown>).suggestions as Record<string, unknown>
  const items = suggestions.items as Record<string, unknown>
  const itemProps = items.properties as Record<string, unknown>
  const meta = itemProps.meta as Record<string, unknown>
  assert.equal(items.additionalProperties, false)
  assert.equal(meta.additionalProperties, false)
})

test('free-form object WITHOUT properties is left untouched', () => {
  const out = strictifySchema({
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { type: 'object' } },
      edges: { type: 'array', items: { type: 'object' } },
    },
    required: ['nodes', 'edges'],
  })
  const nodes = (out.properties as Record<string, unknown>).nodes as Record<string, unknown>
  const items = nodes.items as Record<string, unknown>
  // The free-form items object has no `properties`, so it must be left alone —
  // forcing additionalProperties:false here would collapse it to {} only.
  assert.equal('additionalProperties' in items, false)
  // But the top-level wrapper DOES have properties, so it still gets closed.
  assert.equal(out.additionalProperties, false)
})

test('arrays/items are recursed into for anyOf/oneOf/allOf too', () => {
  const out = strictifySchema({
    type: 'object',
    properties: {
      value: {
        anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'string' },
        ],
      },
    },
    required: ['value'],
  })
  const value = (out.properties as Record<string, unknown>).value as Record<string, unknown>
  const anyOf = value.anyOf as Record<string, unknown>[]
  assert.equal(anyOf[0].additionalProperties, false)
  assert.equal(anyOf[1].type, 'string')
})

test('explicit additionalProperties:true is preserved, not overwritten', () => {
  const out = strictifySchema({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: true,
  })
  assert.equal(out.additionalProperties, true)
})

test('explicit additionalProperties:false is preserved unchanged', () => {
  const out = strictifySchema({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  })
  assert.equal(out.additionalProperties, false)
})

test('$defs / definitions objects are recursed into', () => {
  const out = strictifySchema({
    type: 'object',
    properties: { thing: { $ref: '#/$defs/Thing' } },
    required: ['thing'],
    $defs: {
      Thing: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  })
  const defs = out.$defs as Record<string, unknown>
  const thing = defs.Thing as Record<string, unknown>
  assert.equal(thing.additionalProperties, false)
})

test('does not mutate the input schema (pure function)', () => {
  const input = {
    type: 'object' as const,
    properties: { name: { type: 'string' as const } },
    required: ['name'],
  }
  const snapshot = JSON.parse(JSON.stringify(input))
  strictifySchema(input)
  assert.deepEqual(input, snapshot)
})
