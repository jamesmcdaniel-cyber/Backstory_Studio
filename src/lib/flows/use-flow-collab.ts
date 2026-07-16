'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

export type CollabParticipant = { clientId: string; userId: string; name: string; color: string }

// Broadcast at most one graph per this interval, so continuous editing streams
// live but a 10-person session can't flood the channel (leading + trailing edge).
const BROADCAST_INTERVAL_MS = 220
// Skip live-broadcasting a graph whose JSON exceeds this — a frame that large
// over Realtime at scale is a bandwidth/limit risk; co-editors pick the change
// up on the next save/reload instead.
const MAX_BROADCAST_BYTES = 180_000

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

/**
 * Live collaboration on a flow via Supabase Realtime:
 *  - PRESENCE: who else is in this flow right now (feeds the Jam "here now" +
 *    the toolbar avatar stack).
 *  - BROADCAST: push the local graph to co-editors and receive theirs, so edits
 *    appear live. Own echoes are dropped by clientId. Remote graphs are applied
 *    via the caller's onRemoteGraph (which uses setGraph, NOT the undo-history
 *    commit path — so a co-editor's change never pollutes your undo stack nor
 *    re-broadcasts).
 *
 * Live-sync semantics are last-broadcast-wins at graph granularity; persistence
 * conflicts are caught separately by the save route's optimistic lock
 * (FLOW_STALE_WRITE). No-op (empty participants, no-op broadcast) until `self`
 * and a configured Supabase are available, so it degrades cleanly.
 */
export function useFlowCollab(
  flowId: string,
  self: { userId: string; name: string } | null,
  onRemoteGraph: (graph: unknown) => void,
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

  const userId = self?.userId
  const name = self?.name

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
        // Someone else joined: push our CURRENT (possibly unsaved) graph so the
        // newcomer adopts the live state instead of overwriting us with the
        // stale persisted graph they just loaded. The newcomer never broadcasts
        // its loaded graph (see page.tsx's mount guard), so this is the sync.
        if (key === clientId) return
        const graph = getLocalRef.current()
        if (graph !== undefined) channel.send({ type: 'broadcast', event: 'graph', payload: { clientId, graph } })
      })
      .on('broadcast', { event: 'graph' }, ({ payload }) => {
        const p = payload as { clientId?: string; graph?: unknown } | undefined
        if (!p || p.clientId === clientId) return // ignore our own echo
        if (p.graph !== undefined) onRemoteRef.current(p.graph)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void channel.track({ clientId, userId, name: name ?? 'Teammate', color })
      })
    return () => {
      channelRef.current = null
      void channel.untrack().catch(() => {})
      void supabase.removeChannel(channel)
    }
  }, [flowId, userId, name, clientId])

  // Throttled + size-guarded broadcast: streams live while editing but caps the
  // rate, and drops payloads too large for a Realtime frame at scale.
  const lastSentAt = useRef(0)
  const pendingGraph = useRef<unknown>(undefined)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendNow = useCallback((graph: unknown) => {
    let size: number
    try { size = JSON.stringify(graph).length } catch { return }
    if (size > MAX_BROADCAST_BYTES) return // too big for a live frame; syncs on save
    channelRef.current?.send({ type: 'broadcast', event: 'graph', payload: { clientId, graph } })
  }, [clientId])
  const broadcastGraph = useCallback((graph: unknown) => {
    const elapsed = Date.now() - lastSentAt.current
    if (elapsed >= BROADCAST_INTERVAL_MS) {
      lastSentAt.current = Date.now()
      sendNow(graph)
      return
    }
    pendingGraph.current = graph
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        lastSentAt.current = Date.now()
        if (pendingGraph.current !== undefined) { sendNow(pendingGraph.current); pendingGraph.current = undefined }
      }, BROADCAST_INTERVAL_MS - elapsed)
    }
  }, [sendNow])

  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current) }, [])

  return { participants, broadcastGraph, selfClientId: clientId }
}
