import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedQuery, embeddingsConfigured } from '@/lib/rag/embeddings'
import { cosine, keywordScore } from '@/lib/knowledge/retrieve'

export const MEMORY_SIMILARITY_THRESHOLD = 0.86
export const KEYWORD_MATCH_THRESHOLD = 0.6
export const MEMORY_INJECTION_LIMIT = 6
export const AGENT_MEMORY_CAP = 500

export type MemoryKind = 'user_answer' | 'learning' | 'suggestion'
export type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number }

function embeddingOf(value: unknown): number[] | null {
  return Array.isArray(value) ? (value as number[]) : null
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null
  try {
    return await embedQuery(text.slice(0, 4000))
  } catch {
    return null
  }
}

/**
 * Persist one agent memory. Suggestions are deduped against open OR dismissed
 * suggestions (>= threshold cosine bumps timesUsed on the survivor instead of
 * inserting). A dismissed match keeps its 'dismissed' status — dismissing a
 * suggestion is durable and must not be undone by a later run re-proposing
 * the same thing. Enforces the per-agent cap by superseding the oldest
 * learnings. Never throws.
 */
export async function saveAgentMemory(params: {
  organizationId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  question?: string
  sourceExecutionId?: string
}): Promise<{ id: string; deduped: boolean } | null> {
  try {
    const embedText = params.kind === 'user_answer' ? params.question ?? params.content : `${params.title}\n${params.content}`
    const embedding = await tryEmbed(embedText)

    if (params.kind === 'suggestion' && embedding) {
      const existing = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, kind: 'suggestion', status: { in: ['open', 'dismissed'] } },
        select: { id: true, embedding: true },
        take: 100,
      })
      for (const candidate of existing) {
        const vec = embeddingOf(candidate.embedding)
        if (vec && cosine(embedding, vec) >= MEMORY_SIMILARITY_THRESHOLD) {
          // Do NOT touch status here: a dismissed suggestion must stay dismissed.
          await prisma.agentMemory.update({
            where: { id: candidate.id },
            data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
          })
          return { id: candidate.id, deduped: true }
        }
      }
    }

    const created = await prisma.agentMemory.create({
      data: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title.slice(0, 200),
        content: params.content,
        question: params.question,
        embedding: embedding ?? undefined,
        sourceExecutionId: params.sourceExecutionId,
      },
    })

    // Cap: supersede the oldest open learnings beyond the limit.
    const openCount = await prisma.agentMemory.count({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
    })
    if (openCount > AGENT_MEMORY_CAP) {
      const overflow = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open', kind: 'learning' },
        orderBy: { createdAt: 'asc' },
        take: openCount - AGENT_MEMORY_CAP,
        select: { id: true },
      })
      if (overflow.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: overflow.map((m) => m.id) } },
          data: { status: 'superseded' },
        })
      }
    }

    void import('@/lib/rag/indexer')
      .then((indexer) => indexer.indexAgentMemory({
        memoryId: created.id,
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title,
        content: params.content,
      }))
      .catch(() => undefined)

    return { id: created.id, deduped: false }
  } catch (error) {
    apiLogger.warn('saveAgentMemory failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** Top-k open memories for this agent, cosine when embedded else keyword. Never throws. */
export async function retrieveAgentMemory(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
}): Promise<MemoryHit[]> {
  const k = params.k ?? MEMORY_INJECTION_LIMIT
  try {
    const rows = await prisma.agentMemory.findMany({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
      select: { id: true, kind: true, title: true, content: true, question: true, embedding: true },
      orderBy: { createdAt: 'desc' },
      take: AGENT_MEMORY_CAP,
    })
    if (!rows.length) return []
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query.slice(0, 2000))
      } catch {
        queryVec = null
      }
    }
    const scored = rows.map((row) => {
      const vec = embeddingOf(row.embedding)
      const text = `${row.title}\n${row.question ?? ''}\n${row.content}`
      const score = queryVec && vec ? cosine(queryVec, vec) : keywordScore(params.query, text)
      return { id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0).slice(0, k)
  } catch {
    return []
  }
}

/** Render memory + critique blocks for the system prompt. '' when empty. */
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string {
  const parts: string[] = []
  if (hits.length) {
    const body = hits
      .map((h) => {
        if (h.kind === 'user_answer' && h.question) return `— Previously asked: "${h.question}" → the user answered: ${h.content}`
        return `— ${h.title}: ${h.content}`
      })
      .join('\n')
    parts.push(`## What you've learned (from previous runs)\nApply these remembered facts and lessons; do not re-ask questions the user already answered unless something changed.\n\n${body}`)
  }
  if (latestCritique?.trim()) {
    parts.push(`## Notes to self from last run\n${latestCritique.trim()}`)
  }
  return parts.join('\n\n')
}

/** Pure matcher: closest remembered answer for a question, or null. */
export function bestAnswerMatch(
  questionVec: number[] | null,
  question: string,
  candidates: { id: string; question: string | null; content: string; embedding: unknown }[],
): { id: string; content: string; score: number } | null {
  let best: { id: string; content: string; score: number } | null = null
  for (const candidate of candidates) {
    const vec = embeddingOf(candidate.embedding)
    const score =
      questionVec && vec
        ? cosine(questionVec, vec)
        : candidate.question
          ? keywordScore(question, candidate.question)
          : 0
    const threshold = questionVec && vec ? MEMORY_SIMILARITY_THRESHOLD : KEYWORD_MATCH_THRESHOLD
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: candidate.id, content: candidate.content, score }
    }
  }
  return best
}

/** Bump usage counters. Best-effort. */
export async function markMemoriesUsed(ids: string[]): Promise<void> {
  if (!ids.length) return
  try {
    await prisma.agentMemory.updateMany({
      where: { id: { in: ids } },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    })
  } catch {
    /* best-effort */
  }
}
