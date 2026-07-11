import type { RetrievalMetrics } from './types'

/** Recall@k: fraction of the gold doc ids that appear in the top-k retrieved. */
export function recallAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 0
  const top = new Set(retrieved.slice(0, k))
  const found = gold.filter((docId) => top.has(docId)).length
  return found / gold.length
}

/** Reciprocal rank of the first gold hit in the retrieved list (0 if none). */
export function reciprocalRank(retrieved: string[], gold: string[]): number {
  const goldSet = new Set(gold)
  for (let i = 0; i < retrieved.length; i += 1) {
    if (goldSet.has(retrieved[i])) return 1 / (i + 1)
  }
  return 0
}

/** Arithmetic mean; 0 for the empty list (never NaN). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Aggregate recall@{3,5,10} + MRR over answerable queries only (gold non-empty). */
export function retrievalMetrics(perQuery: Array<{ retrieved: string[]; gold: string[] }>): RetrievalMetrics {
  const answerable = perQuery.filter((q) => q.gold.length > 0)
  return {
    recallAt3: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 3))),
    recallAt5: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 5))),
    recallAt10: mean(answerable.map((q) => recallAtK(q.retrieved, q.gold, 10))),
    mrr: mean(answerable.map((q) => reciprocalRank(q.retrieved, q.gold))),
  }
}
