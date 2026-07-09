import { test } from 'node:test'
import assert from 'node:assert/strict'
import { structuredResponseInstruction, parseStructuredAgentOutput } from '../agent-response'

const FIELDS = [
  { name: 'score', type: 'number' as const, description: 'Fit score 0-100' },
  { name: 'summary', type: 'string' as const },
]

test('structuredResponseInstruction lists every property with its type', () => {
  const instruction = structuredResponseInstruction(FIELDS)
  assert.match(instruction, /JSON object/)
  assert.match(instruction, /"score" \(number\): Fit score 0-100/)
  assert.match(instruction, /"summary" \(string\)/)
})

test('parseStructuredAgentOutput accepts a clean JSON reply', () => {
  const result = parseStructuredAgentOutput('{"score": 88, "summary": "Great fit"}', FIELDS)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.output, { score: 88, summary: 'Great fit' })
})

test('parseStructuredAgentOutput tolerates code fences and surrounding prose', () => {
  const fenced = 'Here you go:\n```json\n{"score": 12, "summary": "Weak"}\n```\nLet me know!'
  assert.deepEqual(parseStructuredAgentOutput(fenced, FIELDS).output, { score: 12, summary: 'Weak' })
})

test('parseStructuredAgentOutput accepts an already-structured object', () => {
  assert.deepEqual(parseStructuredAgentOutput({ score: 1, summary: 'x' }, FIELDS).output, { score: 1, summary: 'x' })
})

test('parseStructuredAgentOutput reports missing properties', () => {
  const result = parseStructuredAgentOutput('{"score": 5}', FIELDS)
  assert.match(result.error ?? '', /summary/)
  assert.equal(result.output, undefined)
})

test('parseStructuredAgentOutput fails on non-JSON replies', () => {
  const result = parseStructuredAgentOutput('I could not decide.', FIELDS)
  assert.match(result.error ?? '', /JSON/)
})
