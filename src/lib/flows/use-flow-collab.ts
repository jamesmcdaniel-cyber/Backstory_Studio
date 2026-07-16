'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import { diffGraph, applyGraphOps, isEmptyOps } from '@/lib/flows/graph-ops'

export type CollabParticipant = { clientId: string; userId: string; name: string; color: string }

// Coalesce edits to at most one message per interval (leading + trailing) so a
// 10-person session can't flood the channel while still feeling live.
const BROADCAST_INTERVAL_MS = 200
// Never put a single message larger than this on the wire. Incremental OPS are
// tiny so they never hit it; only a full-state sync of a huge graph might, and
// there the newcomer just falls back to the persisted graph they already loaded.
const MAX_BROADCAST_BYTES = 200_000

// A small, high-contrast palette; a user hashes to a stable color so the same
// person is the same color across a session (Figma-style presence).
const PRESENCE_COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6']

/** Deterministic color for a user id. */
export function presenceColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]
}

/** Dedupe a presence-state list to one entry per user (a user with two tabs
 *  shouldn't show twice); the newest clientId per user wins. */
export function dedupeParticipants(list: CollabParticipant[]): CollabParticipant[] {
  const byUser = new Map<string, CollabParticipant>()
  for (const p of list) if (p.userId) byUser.set(p.userId, p)
  return Array.from(byUser.values())
}

const isGraph = (v: unknown): v is FlowGraph =>
  Boolean(v && typeof v === 'object' && Array.isArray((v as FlowGraph).nodes) && Array.isArray((v as FlowGraph).edges))

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] }

/**
 * Live collaboration on a flow via Supabase Realtime:
 *  - PRESENCE: who else is in this flow right now (feeds the Jam "here now" +
 *    the toolbar avatar stack).
 *  - OP-BASED GRAPH SYNC: a local edit is broadcast as the minimal change-set
 *    (upsert/remove nodes/edges by id), and a co-editor MERGES it into their own
 *    graph rather than replacing it. So two people editing DIFFERENT nodes never
 *    clobber each other; only concurrent edits to the SAME node contend (last op
 *    wins per node). Each op is tiny, so large graphs never blow the message
 *    size. A newcomer gets one FULL-state message on join to bootstrap.
 *
 * Remote changes are applied via `onRemoteGraph` (which uses setGraph, NOT the
 * undo-history commit path — so a co-editor's change never pollutes your undo
 * stack nor re-broadcasts). Persistence conflicts are caught separately by the
 * save route's optimistic lock (FLOW_STALE_WRITE). Degrades cleanly (empty
 * presence, no-op broadcast) until `self` and a configured Supabase exist.
 */
export function useFlowCollab(
  flowId: string,
  self: { userId: string; name: string } | null,
  onRemoteGraph: (graph: FlowGraph) => void,
  getLocalGraph: () => unknown,
): { participants: CollabParticipant[]; broadcastGraph: (graph: unknown) => void; selfClientId: string } {
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)
  // One id per tab so a user's own broadcasts are ignored and two tabs are one
  // presence entry.
  const clientId = useMemo(
    () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.floor(performance.now())}`),
    [],
  )
  const onRemoteRef = useRef(onRemoteGraph)
  onRemoteRef.current = onRemoteGraph
  const getLocalRef = useRef(getLocalGraph)
  getLocalRef.current = getLocalGraph
  // The last graph state shared with the room (sent or received). Diffs are
  // computed against it; merges advance it. This is what keeps ops minimal and
  // convergent.
  const lastGraphRef = useRef<FlowGraph>(EMPTY_GRAPH)

  const userId = self?.userId
  const name = self?.name

  // Serialize + size-guard, then send.
  const sendPayload = useCallback((payload: Record<string, unknown>) => {
    let size: number
    try { size = JSON.stringify(payload).length } catch { return }
    if (size > MAX_BROADCAST_BYTES) return
    channelRef.current?.send({ type: 'broadcast', event: 'graph', payload })
  }, [])

  useEffect(() => {
    if (!userId) return
    let channel: RealtimeChannel
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
      channel = supabase.channel(`flow:${flowId}`, { config: { presence: { key: clientId } } })
    } catch {
      return // Supabase not configured — presence simply stays empty.
    }
    const color = presenceColor(userId)
    channelRef.current = channel
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<CollabParticipant>()
        setParticipants(dedupeParticipants(Object.values(state).flat()))
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        // Someone joined: send our CURRENT (possibly unsaved) FULL graph so they
        // adopt the live state, not the stale persisted graph they just loaded.
        if (key === clientId) return
        const graph = getLocalRef.current()
        if (isGraph(graph)) sendPayload({ clientId, full: graph })
      })
      .on('broadcast', { event: 'graph' }, ({ payload }) => {
        const p = payload as { clientId?: string; full?: unknown; ops?: unknown } | undefined
        if (!p || p.clientId === clientId) return // ignore our own echo
        if (isGraph(p.full)) {
          // Bootstrap / re-sync: adopt the full state.
          lastGraphRef.current = p.full
          onRemoteRef.current(p.full)
          return
        }
        if (p.ops && typeof p.ops === 'object') {
          // Merge the change-set into OUR current local graph so our unsent
          // edits survive; advance the shared baseline to the merged result.
          const local = getLocalRef.current()
          const base = isGraph(local) ? local : lastGraphRef.current
          const merged = applyGraphOps(base, p.ops)
          lastGraphRef.current = merged
          onRemoteRef.current(merged)
        }
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        const graph = getLocalRef.current()
        if (isGraph(graph)) lastGraphRef.current = graph // baseline = the loaded graph
        void channel.track({ clientId, userId, name: name ?? 'Teammate', color })
      })
    return () => {
      channelRef.current = null
      void channel.untrack().catch(() => {})
      void supabase.removeChannel(channel)
    }
  }, [flowId, userId, name, clientId, sendPayload])

  // Op-based broadcast, throttled at the flush edge: diff the latest graph
  // against the last shared baseline and send only the change-set.
  const lastSentAt = useRef(0)
  const pendingGraph = useRef<FlowGraph | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    const target = pendingGraph.current
    pendingGraph.current = null
    if (!target) return
    const ops = diffGraph(lastGraphRef.current, target)
    lastGraphRef.current = target
    lastSentAt.current = Date.now()
    if (isEmptyOps(ops)) return
    sendPayload({ clientId, ops })
  }, [clientId, sendPayload])
  const broadcastGraph = useCallback((graph: unknown) => {
    if (!isGraph(graph)) return
    pendingGraph.current = graph
    const elapsed = Date.now() - lastSentAt.current
    if (elapsed >= BROADCAST_INTERVAL_MS) {
      flush()
      return
    }
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        flush()
      }, BROADCAST_INTERVAL_MS - elapsed)
    }
  }, [flush])

  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current) }, [])

  return { participants, broadcastGraph, selfClientId: clientId }
}
