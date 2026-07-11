/**
 * Types for the RAG + grounding eval. A GoldenItem is one graded query: an
 * answerable question tagged with the corpus doc ids it's answerable from and a
 * reference answer, or an adversarial `unanswerable` query (no sourceDocIds)
 * used to measure the grounding-refusal fix.
 */
export interface GoldenItem {
  id: string
  query: string
  /** Corpus doc ids this query is answerable from; empty for unanswerable. */
  sourceDocIds: string[]
  referenceAnswer: string
  unanswerable: boolean
}

export interface RetrievalMetrics {
  recallAt3: number
  recallAt5: number
  recallAt10: number
  mrr: number
}

export interface GroundingMetrics {
  meanFaithfulness: number
  meanAnswerRelevance: number
  /** Fraction of unanswerable queries the system correctly declined. */
  refusalRate: number
  judged: number
}

export interface SweepRow {
  floor: number
  meanRecallAt5: number
  /** null when no model key is configured (grounding not measured). */
  meanFaithfulness: number | null
}

export interface RagScorecard {
  corpusDocs: number
  goldenItems: number
  answerable: number
  unanswerable: number
  retrieval: RetrievalMetrics
  grounding: GroundingMetrics | null
  sweep: SweepRow[]
  generatedAtIso: string
}
