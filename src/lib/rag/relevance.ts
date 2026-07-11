/**
 * Relevance floors for retrieval INJECTION.
 *
 * Every retriever returns scored hits (score = 1 - cosine_distance). Ranking
 * quality is measured by the RAG eval; these floors govern what actually gets
 * injected into a run's prompt at the execute-agent boundary. Dropping
 * below-floor hits stops weak matches from padding the prompt and inviting the
 * model to treat noise as fact (the hallucination amplifier). The raw
 * retrievers stay unfiltered unless a caller passes minScore, so the eval can
 * sweep thresholds over the same ranked list.
 *
 * Values are cosine-similarity cutoffs, tuned from `npm run eval:rag`'s
 * threshold sweep (see docs/superpowers/plans — Task 6 records the chosen
 * values). They are deliberately conservative starting points.
 */
export const KNOWLEDGE_RELEVANCE_FLOOR = 0.35
export const MEMORY_RELEVANCE_FLOOR = 0.35
export const CONTEXT_RELEVANCE_FLOOR = 0.3

/** Drop hits scoring below `minScore`. No-op when `minScore` is undefined. */
export function applyRelevanceFloor<T extends { score: number }>(hits: T[], minScore?: number): T[] {
  if (minScore == null) return hits
  return hits.filter((hit) => hit.score >= minScore)
}
