import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, reciprocalRank, mean, retrievalMetrics } from '../metrics'
import { loadGolden, corpusDocIds } from '../index'

test('recallAtK counts gold docs found in the top k, over the gold-set size', () => {
  assert.equal(recallAtK(['a', 'b', 'c', 'd'], ['b', 'd'], 3), 0.5) // only b in top-3
  assert.equal(recallAtK(['a', 'b', 'c', 'd'], ['b', 'd'], 4), 1)
  assert.equal(recallAtK(['x', 'y'], ['z'], 5), 0)
})

test('reciprocalRank is 1/(rank of first gold hit), 0 when none present', () => {
  assert.equal(reciprocalRank(['a', 'b', 'c'], ['b']), 1 / 2)
  assert.equal(reciprocalRank(['a', 'b', 'c'], ['a']), 1)
  assert.equal(reciprocalRank(['a', 'b'], ['z']), 0)
})

test('mean handles the empty list without NaN', () => {
  assert.equal(mean([]), 0)
  assert.equal(mean([1, 2, 3]), 2)
})

test('retrievalMetrics ignores unanswerable (empty-gold) queries', () => {
  const m = retrievalMetrics([
    { retrieved: ['a', 'b'], gold: ['a'] },
    { retrieved: ['x'], gold: [] }, // unanswerable — excluded from recall/MRR
  ])
  assert.equal(m.recallAt3, 1)
  assert.equal(m.mrr, 1)
})

test('every golden item references corpus doc ids that exist (answerable) and is well-formed', () => {
  const golden = loadGolden()
  const docs = new Set(corpusDocIds())
  assert.ok(golden.length >= 12, 'expected a non-trivial golden set')
  assert.ok(golden.some((g) => g.unanswerable), 'expected at least one adversarial unanswerable query')
  for (const item of golden) {
    assert.ok(item.id && item.query && typeof item.referenceAnswer === 'string', `item ${item.id} malformed`)
    if (item.unanswerable) {
      assert.equal(item.sourceDocIds.length, 0, `unanswerable ${item.id} must have no sourceDocIds`)
    } else {
      assert.ok(item.sourceDocIds.length > 0, `answerable ${item.id} needs sourceDocIds`)
      for (const docId of item.sourceDocIds) {
        assert.ok(docs.has(docId), `golden ${item.id} references missing corpus doc "${docId}"`)
      }
    }
  }
})
