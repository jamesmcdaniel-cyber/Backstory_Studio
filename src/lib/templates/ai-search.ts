// Pure helpers for the AI template finder (POST /api/templates/ai-search).
// Split out from the route so they're unit-testable without Next.js request
// plumbing: parseMatches tolerates whatever shape the model actually returns,
// sanitizeMatches guards against hallucinated ids before anything reaches the UI.

export type CatalogItem = {
  id: string
  kind: 'template' | 'skill'
  name: string
  description: string
  category: string
  tags?: string[]
}

export type RawMatch = { id: string; reason: string }

export type SanitizedMatch = { id: string; kind: 'template' | 'skill'; reason: string }

const MAX_MATCHES = 5

/**
 * Tolerantly parses the model's reply into a raw match list. Handles a bare
 * JSON object, a ```json fenced block, or a bare ``` fenced block. Any
 * malformed/unexpected shape returns [] rather than throwing — the caller
 * treats "no matches" as a valid outcome, not an error.
 */
export function parseMatches(raw: string): RawMatch[] {
  const trimmed = raw?.trim()
  if (!trimmed) return []

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const text = fenced ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []
  const matches = (parsed as { matches?: unknown }).matches
  if (!Array.isArray(matches)) return []

  const out: RawMatch[] = []
  for (const entry of matches) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    const reason = (entry as { reason?: unknown }).reason
    if (typeof id !== 'string' || !id.trim()) continue
    out.push({ id, reason: typeof reason === 'string' ? reason : '' })
  }
  return out
}

/**
 * Drops any match whose id doesn't correspond to an item the client actually
 * sent (guards against hallucinated ids), de-duplicates, looks up `kind` from
 * the request items, and caps at MAX_MATCHES. Preserves model ranking order.
 */
export function sanitizeMatches(matches: RawMatch[], items: CatalogItem[]): SanitizedMatch[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const out: SanitizedMatch[] = []

  for (const match of matches) {
    if (seen.has(match.id)) continue
    const item = byId.get(match.id)
    if (!item) continue
    seen.add(match.id)
    out.push({ id: item.id, kind: item.kind, reason: match.reason })
    if (out.length >= MAX_MATCHES) break
  }
  return out
}
