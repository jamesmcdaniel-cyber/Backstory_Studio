import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRelevanceFloor, KNOWLEDGE_RELEVANCE_FLOOR, MEMORY_RELEVANCE_FLOOR, CONTEXT_RELEVANCE_FLOOR } from '../relevance'

test('applyRelevanceFloor drops hits below the floor and keeps those at or above it', () => {
  const hits = [{ score: 0.9 }, { score: 0.35 }, { score: 0.2 }, { score: -0.1 }]
  assert.deepEqual(applyRelevanceFloor(hits, 0.35), [{ score: 0.9 }, { score: 0.35 }])
})

test('applyRelevanceFloor is a no-op when minScore is undefined', () => {
  const hits = [{ score: 0.9 }, { score: 0.1 }]
  assert.deepEqual(applyRelevanceFloor(hits, undefined), hits)
})

test('applyRelevanceFloor preserves extra fields on the hit', () => {
  const hits = [{ score: 0.5, id: 'a' }, { score: 0.1, id: 'b' }]
  assert.deepEqual(applyRelevanceFloor(hits, 0.3), [{ score: 0.5, id: 'a' }])
})

test('the exported floor defaults are in a sane cosine range', () => {
  for (const floor of [KNOWLEDGE_RELEVANCE_FLOOR, MEMORY_RELEVANCE_FLOOR, CONTEXT_RELEVANCE_FLOOR]) {
    assert.ok(floor > 0 && floor < 1, `floor ${floor} should be a cosine-similarity cutoff in (0,1)`)
  }
})
