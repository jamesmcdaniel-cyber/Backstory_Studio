import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_GROUPS, AI_CAPABILITY_LEAVES, TRIGGER_LEAVES, searchCorpus } from '../builtin-catalog'

test('built-in groups cover the drill-in taxonomy', () => {
  const ids = BUILTIN_GROUPS.map((g) => g.id)
  assert.deepEqual(ids, ['http', 'control', 'data-operation', 'variable'])
  const control = BUILTIN_GROUPS.find((g) => g.id === 'control')!
  assert.deepEqual(control.children.map((c) => c.stepType), ['condition', 'switch', 'loop', 'parallel', 'stop'])
  const dataOp = BUILTIN_GROUPS.find((g) => g.id === 'data-operation')!
  assert.deepEqual(dataOp.children.map((c) => c.stepType), ['transform', 'filter'])
  const http = BUILTIN_GROUPS.find((g) => g.id === 'http')!
  assert.ok(http.children.every((c) => c.stepType === 'http'))
})

test('every leaf id is unique across groups, AI capabilities, and triggers', () => {
  const all = [...BUILTIN_GROUPS.flatMap((g) => g.children), ...AI_CAPABILITY_LEAVES, ...TRIGGER_LEAVES]
  assert.equal(new Set(all.map((l) => l.id)).size, all.length)
})

test('AI capabilities are action-mode agent steps', () => {
  assert.ok(AI_CAPABILITY_LEAVES.length >= 1)
  assert.ok(AI_CAPABILITY_LEAVES.every((l) => l.mode === 'action' && l.stepType === 'agent'))
})

test('trigger leaves cover all four trigger types', () => {
  assert.deepEqual(TRIGGER_LEAVES.map((l) => l.triggerType), ['manual', 'schedule', 'webhook', 'signal'])
})

test('searchCorpus is lowercase label+description', () => {
  const leaf = TRIGGER_LEAVES[0]
  assert.equal(searchCorpus(leaf), `${leaf.label} ${leaf.description}`.toLowerCase())
})
