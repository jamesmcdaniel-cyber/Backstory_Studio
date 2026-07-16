export type PersisterCandidate = { clientId: string; userId: string; canEdit?: boolean }

/**
 * Deterministically pick the ONE client that persists during a jam: the flow
 * owner's lowest clientId when the owner is present as an editor, else the
 * lowest editor clientId overall. Input order must not matter — every peer
 * computes this from its own presence snapshot and must reach the same
 * answer, or two clients would race the optimistic lock.
 */
export function electPersister(candidates: PersisterCandidate[], ownerUserId?: string | null): string | null {
  const editors = candidates.filter((c) => c.canEdit)
  if (!editors.length) return null
  const pool = ownerUserId && editors.some((c) => c.userId === ownerUserId)
    ? editors.filter((c) => c.userId === ownerUserId)
    : editors
  return pool.map((c) => c.clientId).sort()[0] ?? null
}

/**
 * When a newcomer joins, exactly ONE existing client answers with the full
 * live graph (lowest clientId among those already present) — instead of every
 * peer blasting a bootstrap at once.
 */
export function shouldAnswerBootstrap(
  presentClientIds: string[],
  joiningClientId: string,
  selfClientId: string,
): boolean {
  const others = presentClientIds.filter((id) => id !== joiningClientId).sort()
  return others.length > 0 && others[0] === selfClientId
}

/**
 * Client-side audit coalescing for jam autosave: at most one flow-edited
 * audit row per window instead of one per debounce tick, so the activity
 * timeline isn't flooded by a live session.
 */
export function shouldRecordJamAudit(lastRecordedAt: number, now: number, windowMs = 10 * 60 * 1000): boolean {
  return now - lastRecordedAt >= windowMs
}
