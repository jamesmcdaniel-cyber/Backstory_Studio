export type RemoteCursor = {
  clientId: string
  x: number
  y: number
  name: string
  color: string
  /** Local receipt time (ms) — idle cursors fade out via pruneCursors. */
  ts: number
}

/** Upsert by clientId — the latest position wins; new clients append. */
export function upsertCursor(list: RemoteCursor[], incoming: RemoteCursor): RemoteCursor[] {
  const index = list.findIndex((c) => c.clientId === incoming.clientId)
  if (index === -1) return [...list, incoming]
  const next = list.slice()
  next[index] = incoming
  return next
}

/** Drop cursors idle past the TTL or whose client has left the room. */
export function pruneCursors(
  list: RemoteCursor[],
  now: number,
  presentClientIds: Set<string>,
  ttlMs = 5_000,
): RemoteCursor[] {
  const kept = list.filter((c) => now - c.ts <= ttlMs && presentClientIds.has(c.clientId))
  return kept.length === list.length ? list : kept
}
