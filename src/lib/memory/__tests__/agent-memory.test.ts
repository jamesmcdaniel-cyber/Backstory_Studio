import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestAnswerMatch,
  renderAgentMemories,
  MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_INJECTION_LIMIT,
} from '../agent-memory'

const vec = (x: number, y: number) => [x, y]

test('bestAnswerMatch picks the closest embedded question above 0.86', () => {
  const candidates = [
    { id: 'm1', question: 'Which region should I focus on?', content: 'EMEA', embedding: vec(1, 0) },
    { id: 'm2', question: 'What is the pipeline threshold?', content: '$50k', embedding: vec(0, 1) },
  ]
  const hit = bestAnswerMatch(vec(0.99, 0.05), 'Which region?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(hit?.content, 'EMEA')
  assert.ok(hit!.score >= MEMORY_SIMILARITY_THRESHOLD)
})

test('bestAnswerMatch returns null below the threshold', () => {
  const candidates = [{ id: 'm1', question: 'Which region?', content: 'EMEA', embedding: vec(1, 0) }]
  assert.equal(bestAnswerMatch(vec(0.5, 0.87), 'unrelated', candidates), null)
})

test('bestAnswerMatch falls back to keyword overlap without vectors', () => {
  const candidates = [
    { id: 'm1', question: 'Which Salesforce region should the report cover?', content: 'EMEA', embedding: null },
  ]
  const hit = bestAnswerMatch(null, 'Which Salesforce region should this cover?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(bestAnswerMatch(null, 'completely different topic entirely', candidates), null)
})

test('renderAgentMemories renders headings, caps, and critique', () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`, kind: 'learning', title: `T${i}`, content: `Learned ${i}`, question: null, score: 1 - i / 10,
  }))
  const block = renderAgentMemories(hits.slice(0, MEMORY_INJECTION_LIMIT), 'Do fewer tool calls next time.')
  assert.match(block, /## What you've learned \(from previous runs\)/)
  assert.match(block, /Learned 0/)
  assert.match(block, /## Notes to self from last run/)
  assert.match(block, /fewer tool calls/)
  assert.equal(renderAgentMemories([], null), '')
  assert.match(renderAgentMemories([], 'note'), /## Notes to self from last run/)
})
