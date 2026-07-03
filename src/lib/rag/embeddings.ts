/**
 * Embeddings client for graph-RAG.
 *
 * Default provider: Voyage AI (VOYAGE_API_KEY) — Anthropic's recommended
 * embeddings, billed independently of the model keys. The provider is behind a
 * small seam so it can be swapped (OpenAI, a local model) without touching the
 * retrieval/indexing code.
 *
 * Gated: when no key is configured, `embeddingsConfigured()` is false and
 * callers skip RAG augmentation gracefully rather than erroring.
 */

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
// voyage-3 family: 1024-dim general-purpose embeddings; `voyage-3` is the
// balanced default. Override with VOYAGE_EMBED_MODEL if needed.
const DEFAULT_MODEL = 'voyage-3'
export const EMBEDDING_DIM = 1024

export function embeddingsConfigured(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY)
}

export interface EmbedOptions {
  /** 'document' when indexing stored content, 'query' when embedding a search. */
  inputType?: 'document' | 'query'
  fetchImpl?: typeof fetch
  model?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Embed a batch of texts. Returns one vector per input, in order. Retries on
 * rate limits (429) and provider outages (5xx) with backoff honoring
 * Retry-After — Voyage's free tier is a few requests/minute, so indexing bursts
 * (backfill, signal storms) would otherwise 429. Non-retryable errors (bad key,
 * bad request) throw immediately, status-tagged.
 */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not configured')

  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = options.fetchImpl ? 1 : 6 // tests inject fetch and don't want real waits

  let response: Response | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await fetchImpl(VOYAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model || process.env.VOYAGE_EMBED_MODEL || DEFAULT_MODEL,
        input: texts,
        input_type: options.inputType ?? 'document',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.ok) break
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === maxAttempts) break
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** (attempt - 1), 20_000) // 1s,2s,4s,8s,16s,20s
    await sleep(waitMs)
  }

  if (!response || !response.ok) {
    const error = new Error(`Voyage embeddings request failed (${response?.status ?? 'no response'})`) as Error & { status?: number }
    error.status = response?.status
    throw error
  }

  const data = (await response.json()) as { data?: Array<{ embedding: number[]; index: number }> }
  const rows = data.data ?? []
  // Voyage returns items with an explicit index; order defensively.
  const ordered = new Array<number[]>(texts.length)
  for (const row of rows) ordered[row.index] = row.embedding
  for (let i = 0; i < ordered.length; i++) if (!ordered[i]) ordered[i] = []
  return ordered
}

export async function embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], { ...options, inputType: 'query' })
  return vector ?? []
}

/** Cosine similarity between two equal-length vectors (0 when either is empty). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
