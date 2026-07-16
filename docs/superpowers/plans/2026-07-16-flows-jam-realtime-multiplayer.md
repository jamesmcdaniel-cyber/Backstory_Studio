# Flows Jam Real-Time Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flows "Jam" feature into real multiplayer: working invite deep-links, live cursors, who-is-editing rings, jam autosave with one elected persister, a P2P voice huddle, and a rebuilt Jam dialog.

**Architecture:** Everything rides the ONE existing Supabase Realtime channel `flow:${flowId}` (browser → Supabase directly; Vercel holds no sockets). We extend the existing `useFlowCollab` hook with new broadcast events (`cursor`, `saved`, `huddle`) and richer presence (`canEdit`, `selection`, `inHuddle`), add a small event bus so the huddle/autosave features share the channel, and keep durable writes on the existing `PUT /api/flows` optimistic-lock route — but written by a single deterministically-elected client during a jam.

**Tech Stack:** Next.js 15 App Router, React 18 client components, Supabase Realtime (`@supabase/supabase-js ^2.50.0`), Prisma 6 / Postgres, WebRTC (browser-native, STUN-only), `node:test` + `tsx` for unit tests, Tailwind + shadcn-style components.

**Spec:** `docs/superpowers/specs/2026-07-16-flows-jam-realtime-multiplayer-design.md`

## Global Constraints

- No raw `{{token}}` bracket syntax may appear in any user-visible UI copy (user mandate).
- Local dev has NO Supabase/DB env vars by design: verify via `npm run typecheck`, `npm run lint`, `npm test`. Real-time behavior is verified on a Vercel preview with two browser sessions.
- Test runner is `node:test` via tsx. Run one file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Run all: `npm test`.
- Migrations are hand-written SQL in `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`, applied by `prisma migrate deploy` on Vercel/CI. Never run `prisma migrate dev` or `db:push` locally (no DATABASE_URL).
- `npm run typecheck` runs `prisma generate` first — schema changes are visible to tsc without a database.
- The flow canvas is a custom DOM chain (NOT React Flow). Pan = scroll offsets on a container; zoom = `transform: scale(zoom)` on an inner content div with `transformOrigin: 'top center'`.
- Keep the existing exported signatures of `presenceColor` and `dedupeParticipants` unchanged (existing tests depend on them).
- Only ONE Supabase channel per flow. New features must NOT open additional channels.
- Voice is STUN-only in v1 (`stun:stun.l.google.com:19302`); no TURN, no video, no recording.
- Commit after every task with a conventional-commit message ending in the Claude co-author trailer used by this repo.

---

### Task 1: Notification deep link (invite lands on the flow)

The invite's in-app notification currently navigates to `/dashboard` because `Notification` has no `link` column and the bell reconstructs hrefs from `executionId` (null for invites). Fix: persist `link`, prefer it in a pure, tested href helper.

**Files:**
- Create: `prisma/migrations/20260716120000_notification_link/migration.sql`
- Create: `src/lib/notifications/href.ts`
- Create: `src/lib/notifications/__tests__/href.test.ts`
- Modify: `prisma/schema.prisma` (Notification model, lines 362-380)
- Modify: `src/lib/notifications/service.ts` (persist `link`)
- Modify: `src/components/notifications/notification-bell.tsx` (use the helper)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `notificationHref(n: { type: string; executionId?: string | null; link?: string | null }): string` in `src/lib/notifications/href.ts`. `Notification.link String?` column. `notify()` already receives `link` from `POST /api/flows/[id]/invite` (`link: '/flows/<id>'`) — no invite-route change needed.

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/__tests__/href.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationHref } from '../href'

test('prefers the persisted link — a jam invite lands on its flow', () => {
  assert.equal(
    notificationHref({ type: 'flow.jam_invite', executionId: null, link: '/flows/abc123' }),
    '/flows/abc123',
  )
})

test('flow notifications without a link keep the activity-page fallback', () => {
  assert.equal(
    notificationHref({ type: 'flow.run_failed', executionId: 'flow9', link: null }),
    '/flows/flow9/activity',
  )
})

test('non-flow notifications keep the dashboard run fallback', () => {
  assert.equal(notificationHref({ type: 'agent.done', executionId: 'run1' }), '/dashboard?run=run1')
  assert.equal(notificationHref({ type: 'agent.done' }), '/dashboard')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/notifications/__tests__/href.test.ts`
Expected: FAIL — `Cannot find module '../href'`.

- [ ] **Step 3: Write the helper**

Create `src/lib/notifications/href.ts`:

```ts
export type NotificationLinkFields = {
  type: string
  executionId?: string | null
  link?: string | null
}

/**
 * In-app destination for a notification. A persisted `link` (e.g. a jam
 * invite's /flows/<id>) always wins; flow notifications without one carry the
 * FLOW id in executionId and deep-link to that flow's activity page — a flow
 * run id is not resolvable by the dashboard.
 */
export function notificationHref(n: NotificationLinkFields): string {
  if (n.link) return n.link
  if (n.type.startsWith('flow.') && n.executionId) return `/flows/${n.executionId}/activity`
  return n.executionId ? `/dashboard?run=${n.executionId}` : '/dashboard'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/notifications/__tests__/href.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the schema column + migration**

In `prisma/schema.prisma`, inside `model Notification` add one line after `executionId  String?`:

```prisma
  link           String?
```

Create `prisma/migrations/20260716120000_notification_link/migration.sql`:

```sql
-- Jam invites (and future notifications) deep-link somewhere specific; the
-- bell previously reconstructed hrefs from executionId, which is null for
-- invites and sent recipients to /dashboard instead of the invited flow.
ALTER TABLE "public"."notifications" ADD COLUMN "link" TEXT;
```

- [ ] **Step 6: Persist the link in `notify()`**

In `src/lib/notifications/service.ts`, inside `prisma.notification.create`, add after `executionId: input.executionId,`:

```ts
        link: input.link,
```

- [ ] **Step 7: Use the helper in the bell**

In `src/components/notifications/notification-bell.tsx`:

1. Add to imports: `import { notificationHref } from '@/lib/notifications/href'`
2. Add `link?: string | null` to the `NotificationItem` type (after `executionId?: string | null`).
3. Delete the local `notificationHref` function (lines 31-36, including its comment) — the `<a href={notificationHref(n)}>` call site now resolves to the import unchanged.

(The `/api/snapshot` route returns raw notification rows, so `link` flows to the bell automatically once the column exists — no route change.)

- [ ] **Step 8: Typecheck + lint + full tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. (Typecheck regenerates the Prisma client with the new column.)

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260716120000_notification_link src/lib/notifications src/components/notifications/notification-bell.tsx
git commit -m "fix(flows): jam-invite notifications deep-link to the invited flow"
```

---

### Task 2: Pure collab helpers — cursor space, cursor store, roles

All the deterministic logic the real-time features hang off, as tested pure functions.

**Files:**
- Create: `src/lib/flows/cursor-space.ts`
- Create: `src/lib/flows/cursor-store.ts`
- Create: `src/lib/flows/collab-roles.ts`
- Create: `src/lib/flows/__tests__/cursor-space.test.ts`
- Create: `src/lib/flows/__tests__/cursor-store.test.ts`
- Create: `src/lib/flows/__tests__/collab-roles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3-5):
  - `toContentSpace(clientX: number, clientY: number, rect: { left: number; top: number }, zoom: number): { x: number; y: number }`
  - `type RemoteCursor = { clientId: string; x: number; y: number; name: string; color: string; ts: number }`
  - `upsertCursor(list: RemoteCursor[], incoming: RemoteCursor): RemoteCursor[]`
  - `pruneCursors(list: RemoteCursor[], now: number, presentClientIds: Set<string>, ttlMs?: number): RemoteCursor[]`
  - `type PersisterCandidate = { clientId: string; userId: string; canEdit?: boolean }`
  - `electPersister(candidates: PersisterCandidate[], ownerUserId?: string | null): string | null`
  - `shouldAnswerBootstrap(presentClientIds: string[], joiningClientId: string, selfClientId: string): boolean`
  - `shouldRecordJamAudit(lastRecordedAt: number, now: number, windowMs?: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/flows/__tests__/cursor-space.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toContentSpace } from '../cursor-space'

test('maps client coords into un-scaled content space', () => {
  // Content element visually starts at (100, 50); zoom 2 means every content
  // pixel paints as 2 screen pixels.
  assert.deepEqual(toContentSpace(300, 250, { left: 100, top: 50 }, 2), { x: 100, y: 100 })
})

test('zoom 1 is a plain offset', () => {
  assert.deepEqual(toContentSpace(120, 80, { left: 100, top: 50 }, 1), { x: 20, y: 30 })
})

test('guards a zero/negative zoom by treating it as 1', () => {
  assert.deepEqual(toContentSpace(120, 80, { left: 100, top: 50 }, 0), { x: 20, y: 30 })
})
```

Create `src/lib/flows/__tests__/cursor-store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upsertCursor, pruneCursors, type RemoteCursor } from '../cursor-store'

const cursor = (clientId: string, ts: number): RemoteCursor => ({ clientId, x: 1, y: 2, name: 'A', color: '#111', ts })

test('upsertCursor replaces an existing client and appends a new one', () => {
  const a1 = cursor('a', 100)
  const withA = upsertCursor([], a1)
  assert.deepEqual(withA, [a1])
  const a2 = { ...a1, x: 9, ts: 200 }
  const updated = upsertCursor(withA, a2)
  assert.equal(updated.length, 1)
  assert.equal(updated[0].x, 9)
  const withB = upsertCursor(updated, cursor('b', 300))
  assert.equal(withB.length, 2)
})

test('pruneCursors drops idle cursors and departed clients', () => {
  const list = [cursor('fresh', 10_000), cursor('stale', 1_000), cursor('gone', 10_000)]
  const out = pruneCursors(list, 12_000, new Set(['fresh', 'stale']), 5_000)
  assert.deepEqual(out.map((c) => c.clientId), ['fresh'])
})
```

Create `src/lib/flows/__tests__/collab-roles.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { electPersister, shouldAnswerBootstrap, shouldRecordJamAudit } from '../collab-roles'

test('electPersister prefers the owner, then lowest clientId, order-independently', () => {
  const room = [
    { clientId: 'c', userId: 'u2', canEdit: true },
    { clientId: 'b', userId: 'owner', canEdit: true },
    { clientId: 'a', userId: 'u3', canEdit: true },
  ]
  assert.equal(electPersister(room, 'owner'), 'b')
  assert.equal(electPersister([...room].reverse(), 'owner'), 'b', 'input order must not matter')
  assert.equal(electPersister(room, null), 'a', 'no owner present → lowest editor clientId')
})

test('electPersister with the owner on two tabs picks the owner tab with the lowest clientId', () => {
  const room = [
    { clientId: 'z2', userId: 'owner', canEdit: true },
    { clientId: 'z1', userId: 'owner', canEdit: true },
    { clientId: 'a', userId: 'u2', canEdit: true },
  ]
  assert.equal(electPersister(room, 'owner'), 'z1')
})

test('electPersister ignores view-only participants; empty/no-editor rooms elect nobody', () => {
  assert.equal(electPersister([{ clientId: 'a', userId: 'u1', canEdit: false }], null), null)
  assert.equal(electPersister([], 'owner'), null)
})

test('shouldAnswerBootstrap: exactly the lowest already-present client answers', () => {
  const present = ['c', 'a', 'newbie', 'b']
  assert.equal(shouldAnswerBootstrap(present, 'newbie', 'a'), true)
  assert.equal(shouldAnswerBootstrap(present, 'newbie', 'b'), false)
  assert.equal(shouldAnswerBootstrap(['newbie'], 'newbie', 'newbie'), false, 'nobody else present → no answer needed')
})

test('shouldRecordJamAudit coalesces to one audit per window', () => {
  const tenMin = 10 * 60 * 1000
  assert.equal(shouldRecordJamAudit(0, tenMin), true)
  assert.equal(shouldRecordJamAudit(1_000, tenMin), false)
  assert.equal(shouldRecordJamAudit(1_000, 1_000 + tenMin), true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/cursor-space.test.ts src/lib/flows/__tests__/cursor-store.test.ts src/lib/flows/__tests__/collab-roles.test.ts`
Expected: FAIL — cannot find modules `../cursor-space`, `../cursor-store`, `../collab-roles`.

- [ ] **Step 3: Implement the three modules**

Create `src/lib/flows/cursor-space.ts`:

```ts
/**
 * Convert a pointer's client (viewport) coords into canvas CONTENT space —
 * the un-scaled coordinate system nodes are laid out in. `rect` is the
 * bounding rect of the zoom-TRANSFORMED content element, so dividing by zoom
 * undoes the visual scale. A cursor parked on a node then shows on that node
 * for every viewer regardless of their own pan/zoom.
 */
export function toContentSpace(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1
  return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z }
}
```

Create `src/lib/flows/cursor-store.ts`:

```ts
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
```

Create `src/lib/flows/collab-roles.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/cursor-space.test.ts src/lib/flows/__tests__/cursor-store.test.ts src/lib/flows/__tests__/collab-roles.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/cursor-space.ts src/lib/flows/cursor-store.ts src/lib/flows/collab-roles.ts src/lib/flows/__tests__/cursor-space.test.ts src/lib/flows/__tests__/cursor-store.test.ts src/lib/flows/__tests__/collab-roles.test.ts
git commit -m "feat(flows): pure collab helpers — cursor space/store, persister election, audit coalescing"
```

---

### Task 3: Extend `useFlowCollab` — cursors, richer presence, event bus, bootstrap election

Rewrite `src/lib/flows/use-flow-collab.ts` to carry the new traffic on the same channel. Existing graph-sync/presence behavior is preserved; the hook's only consumer is `src/app/flows/[id]/page.tsx` (updated in this task so the build stays green).

**Files:**
- Modify: `src/lib/flows/use-flow-collab.ts` (full-file replacement below)
- Modify: `src/app/flows/[id]/page.tsx` (call-site update, lines ~379-416)
- Test: existing `src/lib/flows/__tests__/use-flow-collab.test.ts` must keep passing unchanged.

**Interfaces:**
- Consumes (Task 2): `upsertCursor`, `pruneCursors`, `RemoteCursor`, `shouldAnswerBootstrap`.
- Produces (used by Tasks 4-8): the hook now takes `self: { userId: string; name: string; canEdit: boolean } | null` and returns:
  ```ts
  {
    participants: CollabParticipant[]   // deduped, one per user — UI
    roster: CollabParticipant[]         // raw, one per tab — deterministic election input
    cursors: RemoteCursor[]             // remote cursors only (never self)
    broadcastGraph: (graph: unknown) => void
    sendCursor: (x: number, y: number) => void
    setSelection: (nodeId: string | null) => void
    setInHuddle: (inHuddle: boolean) => void
    bus: CollabBus
    selfClientId: string
  }
  ```
  with `CollabParticipant` gaining `canEdit?: boolean; selection?: string | null; inHuddle?: boolean`, and
  ```ts
  export type BusEvent = 'saved' | 'huddle'
  export type CollabBus = {
    send: (event: BusEvent, payload: Record<string, unknown>) => void
    on: (event: BusEvent, handler: (payload: Record<string, unknown>) => void) => () => void
  }
  ```
  Bus semantics: `send` broadcasts to the room (tagged with our clientId); `on` delivers REMOTE messages only (own echoes are dropped); the returned function unsubscribes. `bus` and `selfClientId` are referentially stable for the life of the mount.

- [ ] **Step 1: Replace `src/lib/flows/use-flow-collab.ts` with:**

```ts
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import type { FlowGraph } from '@/lib/flows/graph'
import { diffGraph, applyGraphOps, isEmptyOps } from '@/lib/flows/graph-ops'
import { upsertCursor, pruneCursors, type RemoteCursor } from '@/lib/flows/cursor-store'
import { shouldAnswerBootstrap } from '@/lib/flows/collab-roles'

export type { RemoteCursor }

export type CollabParticipant = {
  clientId: string
  userId: string
  name: string
  color: string
  /** May this participant edit? Feeds persister election (jam autosave). */
  canEdit?: boolean
  /** Node id this participant has selected/open — drives the editing ring. */
  selection?: string | null
  /** True while this participant is in the voice huddle. */
  inHuddle?: boolean
}

/** Events other features (jam autosave, voice huddle) exchange over the
 *  flow's ONE channel. Bindings are fixed at subscribe time, so this set is
 *  a whitelist — add here before using a new event. */
export type BusEvent = 'saved' | 'huddle'
export type CollabBus = {
  send: (event: BusEvent, payload: Record<string, unknown>) => void
  on: (event: BusEvent, handler: (payload: Record<string, unknown>) => void) => () => void
}
const BUS_EVENTS: BusEvent[] = ['saved', 'huddle']

// Coalesce edits to at most one message per interval (leading + trailing) so a
// 10-person session can't flood the channel while still feeling live.
const BROADCAST_INTERVAL_MS = 200
// Never put a single message larger than this on the wire. Incremental OPS are
// tiny so they never hit it; only a full-state sync of a huge graph might, and
// there the newcomer just falls back to the persisted graph they already loaded.
const MAX_BROADCAST_BYTES = 200_000
// Cursor stream: ~25 tiny messages/s per client at most; idle cursors fade.
const CURSOR_INTERVAL_MS = 40
const CURSOR_PRUNE_INTERVAL_MS = 1_000

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
 * Live collaboration on a flow via Supabase Realtime — ONE channel carrying:
 *  - PRESENCE: who's here, whether they can edit, which node they have
 *    selected, and whether they're in the voice huddle.
 *  - OP-BASED GRAPH SYNC: a local edit broadcasts the minimal change-set
 *    (upsert/remove nodes/edges by id); co-editors MERGE it (last op wins per
 *    node). A newcomer gets one FULL-state bootstrap from exactly one elected
 *    answerer (lowest present clientId).
 *  - CURSORS: content-space pointer positions, throttled, TTL-pruned.
 *  - BUS ('saved', 'huddle'): jam-autosave base advancement and WebRTC
 *    huddle signaling ride the same channel via a tiny event bus.
 *
 * Remote changes are applied via `onRemoteGraph` (which uses setGraph, NOT the
 * undo-history commit path — so a co-editor's change never pollutes your undo
 * stack nor re-broadcasts). Persistence conflicts are caught separately by the
 * save route's optimistic lock (FLOW_STALE_WRITE). Degrades cleanly (empty
 * presence, no-op broadcast) until `self` and a configured Supabase exist.
 */
export function useFlowCollab(
  flowId: string,
  self: { userId: string; name: string; canEdit: boolean } | null,
  onRemoteGraph: (graph: FlowGraph) => void,
  getLocalGraph: () => unknown,
): {
  participants: CollabParticipant[]
  roster: CollabParticipant[]
  cursors: RemoteCursor[]
  broadcastGraph: (graph: unknown) => void
  sendCursor: (x: number, y: number) => void
  setSelection: (nodeId: string | null) => void
  setInHuddle: (inHuddle: boolean) => void
  bus: CollabBus
  selfClientId: string
} {
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const [roster, setRoster] = useState<CollabParticipant[]>([])
  const [cursors, setCursors] = useState<RemoteCursor[]>([])
  const channelRef = useRef<RealtimeChannel | null>(null)
  const subscribedRef = useRef(false)
  // One id per tab so a user's own broadcasts are ignored and two tabs are one
  // presence entry (in the deduped list; the roster keeps both for election).
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
  // Latest present clientIds — cursor pruning drops departed clients.
  const presentIdsRef = useRef<Set<string>>(new Set())
  // Bus listeners, keyed by event. Channel bindings are registered once at
  // subscribe time and dispatch into this map, so bus.on works before OR
  // after the channel connects.
  const busListeners = useRef<Map<BusEvent, Set<(payload: Record<string, unknown>) => void>>>(new Map())

  const userId = self?.userId
  const name = self?.name
  const canEdit = self?.canEdit ?? false

  // Our full presence payload. Mutated + re-tracked by setSelection/setInHuddle.
  const presenceRef = useRef<CollabParticipant | null>(null)
  const retrack = useCallback(() => {
    if (subscribedRef.current && presenceRef.current) {
      void channelRef.current?.track(presenceRef.current as unknown as Record<string, unknown>)?.catch?.(() => {})
    }
  }, [])

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
    presenceRef.current = {
      clientId,
      userId,
      name: name ?? 'Teammate',
      color,
      canEdit,
      selection: presenceRef.current?.selection ?? null,
      inHuddle: presenceRef.current?.inHuddle ?? false,
    }
    channelRef.current = channel
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<CollabParticipant>()
        const flat = Object.values(state).flat()
        presentIdsRef.current = new Set(flat.map((p) => p.clientId))
        setRoster(flat)
        setParticipants(dedupeParticipants(flat))
        setCursors((prev) => pruneCursors(prev, Date.now(), presentIdsRef.current))
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        // Someone joined: exactly ONE present client (lowest clientId) sends
        // the CURRENT (possibly unsaved) FULL graph so the newcomer adopts the
        // live state, not the stale persisted graph they just loaded. The
        // same path heals a reconnecting client after a network blip — its
        // re-join triggers a fresh bootstrap.
        if (key === clientId) return
        const present = Object.keys(channel.presenceState())
        if (!shouldAnswerBootstrap(present, key, clientId)) return
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
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const p = payload as { clientId?: string; x?: number; y?: number; name?: string; color?: string } | undefined
        if (!p || p.clientId === clientId || typeof p.x !== 'number' || typeof p.y !== 'number') return
        setCursors((prev) =>
          upsertCursor(prev, {
            clientId: p.clientId!,
            x: p.x!,
            y: p.y!,
            name: p.name ?? 'Teammate',
            color: p.color ?? '#6366f1',
            ts: Date.now(),
          }),
        )
      })
    for (const event of BUS_EVENTS) {
      channel.on('broadcast', { event }, ({ payload }) => {
        const p = payload as Record<string, unknown> | undefined
        if (!p || p.clientId === clientId) return // bus delivers REMOTE messages only
        for (const handler of busListeners.current.get(event) ?? []) handler(p)
      })
    }
    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED') {
        subscribedRef.current = false
        return
      }
      subscribedRef.current = true
      const graph = getLocalRef.current()
      if (isGraph(graph)) lastGraphRef.current = graph // baseline = the loaded graph
      retrack()
    })
    return () => {
      subscribedRef.current = false
      channelRef.current = null
      void channel.untrack().catch(() => {})
      void supabase.removeChannel(channel)
    }
  }, [flowId, userId, name, canEdit, clientId, sendPayload, retrack])

  // Idle cursors fade even without presence churn.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCursors((prev) => pruneCursors(prev, Date.now(), presentIdsRef.current))
    }, CURSOR_PRUNE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

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

  // Cursor stream: leading-edge throttle; the next move refreshes the tail.
  const lastCursorAt = useRef(0)
  const sendCursor = useCallback((x: number, y: number) => {
    const now = Date.now()
    if (now - lastCursorAt.current < CURSOR_INTERVAL_MS) return
    lastCursorAt.current = now
    const me = presenceRef.current
    if (!me) return
    channelRef.current?.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, x, y, name: me.name, color: me.color },
    })
  }, [clientId])

  const setSelection = useCallback((nodeId: string | null) => {
    if (!presenceRef.current || presenceRef.current.selection === nodeId) return
    presenceRef.current = { ...presenceRef.current, selection: nodeId }
    retrack()
  }, [retrack])

  const setInHuddle = useCallback((inHuddle: boolean) => {
    if (!presenceRef.current || presenceRef.current.inHuddle === inHuddle) return
    presenceRef.current = { ...presenceRef.current, inHuddle }
    retrack()
  }, [retrack])

  const bus = useMemo<CollabBus>(() => ({
    send: (event, payload) => {
      channelRef.current?.send({ type: 'broadcast', event, payload: { ...payload, clientId } })
    },
    on: (event, handler) => {
      const set = busListeners.current.get(event) ?? new Set()
      set.add(handler)
      busListeners.current.set(event, set)
      return () => { set.delete(handler) }
    },
  }), [clientId])

  return { participants, roster, cursors, broadcastGraph, sendCursor, setSelection, setInHuddle, bus, selfClientId: clientId }
}
```

- [ ] **Step 2: Update the call site in `src/app/flows/[id]/page.tsx`**

In the "Live collaboration (Jam)" block (~line 379):

Replace:

```ts
  const self = useMemo(
    () => (user ? { userId: user.id, name: (user.user_metadata?.full_name as string) || user.email || 'Teammate' } : null),
    [user],
  )
```

with:

```ts
  const self = useMemo(
    () => (user ? { userId: user.id, name: (user.user_metadata?.full_name as string) || user.email || 'Teammate', canEdit } : null),
    [user, canEdit],
  )
```

Replace:

```ts
  const { participants, broadcastGraph, selfClientId } = useFlowCollab(id, self, applyRemoteGraph, () => graphRef.current)
```

with:

```ts
  const { participants, roster, cursors, broadcastGraph, sendCursor, setSelection, setInHuddle, bus, selfClientId } =
    useFlowCollab(id, self, applyRemoteGraph, () => graphRef.current)
```

(`roster`, `cursors`, `sendCursor`, `setSelection`, `setInHuddle`, and `bus` are consumed in Tasks 4, 5, and 7; until then TypeScript may flag them unused — if `npm run lint` complains before those tasks land, prefix nothing and instead add a single `void roster; void cursors; void sendCursor; void setSelection; void setInHuddle; void bus` line immediately after the destructuring with a `// consumed by cursors/autosave/huddle tasks` comment, and REMOVE it in Task 7's cleanup step.)

- [ ] **Step 3: Verify existing tests still pass + gates**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/use-flow-collab.test.ts && npm run typecheck && npm run lint`
Expected: existing 3 collab tests PASS; typecheck and lint clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/flows/use-flow-collab.ts src/app/flows/[id]/page.tsx
git commit -m "feat(flows): collab channel carries cursors, selection/huddle presence, and a saved/huddle bus"
```

---

### Task 4: Cursor layer + "who's editing" rings on the canvas

**Files:**
- Create: `src/components/flows/cursor-layer.tsx`
- Modify: `src/components/flows/flow-canvas.tsx` (new `remoteSelections` prop + ring on `card()`)
- Modify: `src/app/flows/[id]/page.tsx` (pointer wiring, content ref, selection broadcast, render CursorLayer)

**Interfaces:**
- Consumes: `RemoteCursor` + `cursors`/`sendCursor`/`setSelection` (Task 3), `toContentSpace` (Task 2).
- Produces: `CursorLayer({ cursors: RemoteCursor[] })` component; `FlowCanvas` prop `remoteSelections?: Record<string, { name: string; color: string }[]>` (nodeId → remote editors on that node).

- [ ] **Step 1: Create `src/components/flows/cursor-layer.tsx`**

```tsx
'use client'

import type { RemoteCursor } from '@/lib/flows/cursor-store'

/**
 * Remote collaborators' pointers. Rendered INSIDE the zoom-transformed canvas
 * content layer, so content-space coordinates inherit the same pan/zoom the
 * nodes get — a cursor parked on a node shows on that node for every viewer.
 * Positions animate via a short transform transition (the stream is throttled
 * to ~25/s, so CSS interpolates between packets). Idle cursors are pruned by
 * the collab hook; pointer events pass through.
 */
export function CursorLayer({ cursors }: { cursors: RemoteCursor[] }) {
  if (cursors.length === 0) return null
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      {cursors.map((c) => (
        <div
          key={c.clientId}
          className="absolute left-0 top-0 transition-transform duration-100 ease-linear will-change-transform"
          style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
        >
          <svg width="16" height="20" viewBox="0 0 16 20" className="drop-shadow-sm">
            <path d="M1 1l5.5 16 2.4-6.8L15 8.5z" fill={c.color} stroke="white" strokeWidth="1.2" />
          </svg>
          <span
            className="ml-3 inline-block max-w-[140px] -translate-y-1 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: c.color }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add `remoteSelections` to `FlowCanvas`**

In `src/components/flows/flow-canvas.tsx`:

1. Add to the props destructuring (after `onReorderContainer,`): `remoteSelections,`
2. Add to the props type (after the `onReorderContainer?` line):

```ts
  /** nodeId → remote collaborators with that node selected (editing ring + name chip). */
  remoteSelections?: Record<string, { name: string; color: string }[]>
```

3. Replace the `card` helper (currently lines 320-350) with:

```tsx
  const card = (node: FlowNode, index?: number) => {
    const editors = remoteSelections?.[node.id]
    return (
      <div
        data-node-id={node.id}
        className="relative w-full rounded-2xl"
        style={editors?.length ? { boxShadow: `0 0 0 2px ${editors[0].color}` } : undefined}
      >
        {editors && editors.length > 0 && (
          <span
            className="absolute -top-2.5 right-3 z-10 max-w-[200px] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: editors[0].color }}
          >
            {editors.map((e) => e.name).join(', ')} editing
          </span>
        )}
        <StepCard
          node={node}
          index={index}
          title={titleFor(node)}
          subtitle={subtitleFor(node)}
          status={statusByNode[node.id]}
          issues={issuesByNode?.[node.id]}
          selected={selectedId === node.id}
          highlighted={highlightIds?.includes(node.id)}
          agents={agents}
          members={members}
          toolCatalog={toolCatalog}
          dataFields={selectedId === node.id ? dataFields : undefined}
          labelCtx={labelCtx}
          variableNames={selectedId === node.id ? variableNames : undefined}
          flowId={flowId}
          published={published}
          onChange={onChangeNode}
          onClick={() => onSelect(node.id)}
          onRefreshAgents={onRefreshAgents}
          onDuplicate={node.type === 'trigger' ? undefined : onDuplicateNode ? () => onDuplicateNode(node.id) : undefined}
          onMakeSubflow={node.type === 'trigger' || contained.has(node.id) || !onMakeSubflow ? undefined : () => onMakeSubflow(node.id)}
          onDelete={node.type === 'trigger' ? undefined : onDeleteNode ? () => onDeleteNode(node.id) : undefined}
          draggable={node.type !== 'trigger' && node.type !== 'condition' && node.type !== 'switch'}
          onDragStartNode={setDragId}
          onDragEndNode={() => setDragId(null)}
        />
      </div>
    )
  }
```

(Identical StepCard props to today — the only changes are the wrapper's `relative rounded-2xl`, the conditional `boxShadow` ring, and the name chip.)

- [ ] **Step 3: Wire the page — pointer stream, content ref, selection, layer**

In `src/app/flows/[id]/page.tsx`:

1. Add imports:

```ts
import { CursorLayer } from '@/components/flows/cursor-layer'
import { toContentSpace } from '@/lib/flows/cursor-space'
```

and add `PointerEvent as ReactPointerEvent` to the existing `react` type imports if not present (`import type { PointerEvent as ReactPointerEvent } from 'react'`).

2. Below `const canvasPan = useCanvasPan(canvasScrollRef)` (~line 243) add:

```ts
  // The zoom-TRANSFORMED content element — cursor math divides its rect by
  // zoom to get content-space coords (see toContentSpace).
  const canvasContentRef = useRef<HTMLDivElement>(null)
```

3. After the collab destructuring block (Task 3), add:

```ts
  // Live cursors: stream our pointer in content space (throttled in the hook).
  const onCanvasPointerMove = useCallback((event: ReactPointerEvent) => {
    canvasPan.handlers.onPointerMove(event)
    const rect = canvasContentRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = toContentSpace(event.clientX, event.clientY, rect, zoom)
    sendCursor(point.x, point.y)
  }, [canvasPan.handlers, zoom, sendCursor])

  // Who's-editing ring: publish our selected node; render everyone else's.
  useEffect(() => { setSelection(selectedId) }, [selectedId, setSelection])
  const remoteSelections = useMemo(() => {
    const map: Record<string, { name: string; color: string }[]> = {}
    for (const p of others) if (p.selection) (map[p.selection] ??= []).push({ name: p.name, color: p.color })
    return map
  }, [others])
```

4. On the canvas scroll container div (~line 1257), change the handler spread so our combined move handler wins (it still calls the pan handler first):

```tsx
          {...canvasPan.handlers}
          onPointerMove={onCanvasPointerMove}
```

5. Change the zoom-transformed inner div (~line 1267) to carry the ref, relative positioning, and the layer:

```tsx
          <div
            ref={canvasContentRef}
            className="relative"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', width: `${100 / zoom}%`, marginLeft: `${(1 - 1 / zoom) * 50}%` }}
          >
            <CursorLayer cursors={cursors} />
            <FlowCanvas
```

6. Pass the new prop to `FlowCanvas` (add alongside `selectedId={selectedId}`):

```tsx
              remoteSelections={viewingVersion ? undefined : remoteSelections}
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/flows/cursor-layer.tsx src/components/flows/flow-canvas.tsx src/app/flows/[id]/page.tsx
git commit -m "feat(flows): live cursors and who's-editing rings on the jam canvas"
```

---

### Task 5: Jam autosave — one elected persister, no more reload clash

**Files:**
- Modify: `src/app/api/flows/route.ts` (accept `suppressAudit`)
- Modify: `src/lib/flows/serialize.ts` (expose `ownerId`)
- Modify: `src/app/flows/[id]/page.tsx` (election, debounced autosave, `saved` bus handling)

**Interfaces:**
- Consumes: `electPersister`, `shouldRecordJamAudit` (Task 2); `roster`, `bus`, `selfClientId` (Task 3).
- Produces: `PUT /api/flows` accepts optional `suppressAudit: boolean` (skips the `flow.edited` audit for coalesced jam autosaves); `serializeFlow` output gains `ownerId: string | null`; bus event `saved` with payload `{ updatedAt: string }`.

- [ ] **Step 1: Expose the owner in `serializeFlow`**

In `src/lib/flows/serialize.ts`, add to the returned object (after the `canEdit` line):

```ts
    // Flow owner — persister election prefers the owner's client during a jam.
    ownerId: flow.userId ?? null,
```

- [ ] **Step 2: Accept `suppressAudit` in the PUT route**

In `src/app/api/flows/route.ts` PUT handler:

1. In the body schema `z.object({ id: ..., baseUpdatedAt: z.string().optional() })`, add:

```ts
    // Jam autosaves coalesce audit rows client-side (one per window) instead
    // of one per debounce tick.
    suppressAudit: z.boolean().optional(),
```

2. Change the audit guard from `if (body.graph !== undefined) {` to:

```ts
  if (body.graph !== undefined && !body.suppressAudit) {
```

(`suppressAudit` is not in `flowSchema`, and the Prisma `data` object is built from explicit fields, so nothing else changes.)

- [ ] **Step 3: Page — owner state, election, autosave, saved handling**

In `src/app/flows/[id]/page.tsx`:

1. Add imports:

```ts
import { electPersister, shouldRecordJamAudit } from '@/lib/flows/collab-roles'
```

2. Add state next to `const [visibility, setVisibility] = useState('shared')`:

```ts
  const [ownerId, setOwnerId] = useState<string | null>(null)
```

3. In the initial-load `.then` (where `setVisibility(flow.visibility ?? 'shared')` runs), add:

```ts
          setOwnerId(flow.ownerId ?? null)
```

4. After the `others` memo in the collab block, add the whole autosave unit:

```ts
  // ── Jam autosave ────────────────────────────────────────────────────────────
  // All peers share the merged graph via broadcast, so only ONE client needs
  // to write it to Postgres: the deterministically-elected persister (owner
  // first, else lowest editor clientId — every peer computes the same answer
  // from presence). One writer → zero optimistic-lock contention during a
  // jam; the election self-heals when the persister leaves. Solo editing gets
  // plain autosave (the sole editor elects itself).
  const isPersister = useMemo(
    () => electPersister(roster.map((p) => ({ clientId: p.clientId, userId: p.userId, canEdit: p.canEdit })), ownerId) === selfClientId,
    [roster, ownerId, selfClientId],
  )
  const lastJamAuditAt = useRef(0)
  const autosave = useCallback(async () => {
    if (!canEdit || viewingVersion) return
    const suppressAudit = !shouldRecordJamAudit(lastJamAuditAt.current, Date.now())
    const response = await fetch('/api/flows', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // Graph only: name/description/status keep manual save + the dirty dot.
      body: JSON.stringify({ id, graph: graphRef.current, suppressAudit, ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}) }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      if (data.code === 'FLOW_STALE_WRITE') {
        // Someone outside the jam saved over us — same recovery as manual save.
        toast.error('A teammate saved changes since you opened this — reloading the latest.', { duration: 5000 })
        window.setTimeout(() => window.location.reload(), 800)
      }
      return // transient failures: the next edit re-arms the debounce
    }
    const data = await response.json().catch(() => ({}))
    if (data.flow?.updatedAt) {
      baseUpdatedAt.current = data.flow.updatedAt
      if (!suppressAudit) lastJamAuditAt.current = Date.now()
      // Mark the GRAPH portion saved so the dirty dot reflects only unsaved
      // name/description/status edits.
      setSavedSnapshot((prev) => {
        if (!prev) return prev
        try { return JSON.stringify({ ...JSON.parse(prev), graph: graphRef.current }) } catch { return prev }
      })
      // Everyone advances their optimistic-concurrency base — no stale-write
      // reloads between jam participants.
      bus.send('saved', { updatedAt: data.flow.updatedAt })
    }
  }, [id, canEdit, viewingVersion, bus])
  // Debounce: persist 2s after the last graph change (local OR merged remote —
  // the persister persists the whole room's work).
  useEffect(() => {
    if (!canEdit || !isPersister || viewingVersion) return
    if (graph === loadedGraphRef.current) return
    const timer = window.setTimeout(() => { void autosave() }, 2000)
    return () => window.clearTimeout(timer)
  }, [graph, canEdit, isPersister, viewingVersion, autosave])
  // A co-editor's autosave advances OUR base + graph-saved marker too.
  useEffect(() => bus.on('saved', (payload) => {
    const updatedAt = typeof payload.updatedAt === 'string' ? payload.updatedAt : null
    if (!updatedAt) return
    baseUpdatedAt.current = updatedAt
    setSavedSnapshot((prev) => {
      if (!prev) return prev
      try { return JSON.stringify({ ...JSON.parse(prev), graph: graphRef.current }) } catch { return prev }
    })
  }), [bus])
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. (Election + audit-coalescing logic is already unit-tested in Task 2; the wiring is exercised live in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/flows/route.ts src/lib/flows/serialize.ts src/app/flows/[id]/page.tsx
git commit -m "feat(flows): jam autosave via a single elected persister; shared optimistic base"
```

---

### Task 6: Huddle signaling policy + audio level (pure) and the mic policy header

**Files:**
- Create: `src/lib/flows/huddle-signals.ts`
- Create: `src/lib/flows/audio-level.ts`
- Create: `src/lib/flows/__tests__/huddle-signals.test.ts`
- Create: `src/lib/flows/__tests__/audio-level.test.ts`
- Modify: `next.config.js` (line 18, Permissions-Policy)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 7):
  - `type HuddleSignal = { kind: 'join' | 'leave' | 'offer' | 'answer' | 'ice'; from: string; to?: string; sdp?: unknown; candidate?: unknown }`
  - `type HuddleInstruction = { action: 'create-offer' | 'close'; peerId: string } | { action: 'apply-offer' | 'apply-answer'; peerId: string; sdp: unknown } | { action: 'add-ice'; peerId: string; candidate: unknown }`
  - `reduceHuddleSignal(selfId: string, joined: boolean, peerIds: string[], signal: HuddleSignal): HuddleInstruction[]`
  - `rmsLevel(samples: Uint8Array): number`, `SPEAKING_THRESHOLD = 0.04`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/flows/__tests__/huddle-signals.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceHuddleSignal, type HuddleSignal } from '../huddle-signals'

const join = (from: string): HuddleSignal => ({ kind: 'join', from })

test('an existing member offers to a newcomer — one deterministic initiator per pair', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, [], join('peer')), [{ action: 'create-offer', peerId: 'peer' }])
})

test('not in the huddle → a join is ignored; duplicate joins do not re-offer', () => {
  assert.deepEqual(reduceHuddleSignal('me', false, [], join('peer')), [])
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], join('peer')), [])
})

test('own broadcasts are ignored', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, [], join('me')), [])
})

test('targeted offer/answer/ice apply only when addressed to us', () => {
  const offer: HuddleSignal = { kind: 'offer', from: 'peer', to: 'me', sdp: { type: 'offer' } }
  assert.deepEqual(reduceHuddleSignal('me', true, [], offer), [{ action: 'apply-offer', peerId: 'peer', sdp: { type: 'offer' } }])
  assert.deepEqual(reduceHuddleSignal('me', true, [], { ...offer, to: 'someone-else' }), [])
  const answer: HuddleSignal = { kind: 'answer', from: 'peer', to: 'me', sdp: { type: 'answer' } }
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], answer), [{ action: 'apply-answer', peerId: 'peer', sdp: { type: 'answer' } }])
  const ice: HuddleSignal = { kind: 'ice', from: 'peer', to: 'me', candidate: { candidate: 'x' } }
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], ice), [{ action: 'add-ice', peerId: 'peer', candidate: { candidate: 'x' } }])
})

test('leave closes a known peer and ignores unknown ones', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], { kind: 'leave', from: 'peer' }), [{ action: 'close', peerId: 'peer' }])
  assert.deepEqual(reduceHuddleSignal('me', true, [], { kind: 'leave', from: 'stranger' }), [])
})
```

Create `src/lib/flows/__tests__/audio-level.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmsLevel, SPEAKING_THRESHOLD } from '../audio-level'

test('silence (all 128) is 0; a loud square wave approaches 1', () => {
  assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0)
  const loud = new Uint8Array(64)
  for (let i = 0; i < loud.length; i++) loud[i] = i % 2 ? 255 : 0
  assert.ok(rmsLevel(loud) > 0.9)
})

test('empty buffer is 0 and threshold is sane', () => {
  assert.equal(rmsLevel(new Uint8Array(0)), 0)
  assert.ok(SPEAKING_THRESHOLD > 0 && SPEAKING_THRESHOLD < 0.5)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/huddle-signals.test.ts src/lib/flows/__tests__/audio-level.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `src/lib/flows/huddle-signals.ts`:

```ts
/** A voice-huddle signaling message on the flow channel's 'huddle' bus event.
 *  join/leave are room-wide; offer/answer/ice are addressed via `to`. */
export type HuddleSignal = {
  kind: 'join' | 'leave' | 'offer' | 'answer' | 'ice'
  from: string
  to?: string
  sdp?: unknown
  candidate?: unknown
}

export type HuddleInstruction =
  | { action: 'create-offer'; peerId: string }
  | { action: 'apply-offer'; peerId: string; sdp: unknown }
  | { action: 'apply-answer'; peerId: string; sdp: unknown }
  | { action: 'add-ice'; peerId: string; candidate: unknown }
  | { action: 'close'; peerId: string }

/**
 * Pure signaling policy for the P2P mesh: EXISTING members initiate the offer
 * to a newcomer (one deterministic initiator per pair — no glare), targeted
 * messages apply only when addressed to us, own broadcasts are ignored. The
 * WebRTC side effects live in useFlowHuddle; this stays testable.
 */
export function reduceHuddleSignal(
  selfId: string,
  joined: boolean,
  peerIds: string[],
  signal: HuddleSignal,
): HuddleInstruction[] {
  if (signal.from === selfId) return []
  switch (signal.kind) {
    case 'join':
      return joined && !peerIds.includes(signal.from) ? [{ action: 'create-offer', peerId: signal.from }] : []
    case 'leave':
      return peerIds.includes(signal.from) ? [{ action: 'close', peerId: signal.from }] : []
    case 'offer':
      return joined && signal.to === selfId ? [{ action: 'apply-offer', peerId: signal.from, sdp: signal.sdp }] : []
    case 'answer':
      return joined && signal.to === selfId ? [{ action: 'apply-answer', peerId: signal.from, sdp: signal.sdp }] : []
    case 'ice':
      return joined && signal.to === selfId ? [{ action: 'add-ice', peerId: signal.from, candidate: signal.candidate }] : []
  }
}
```

Create `src/lib/flows/audio-level.ts`:

```ts
/** RMS of an 8-bit time-domain sample buffer (0 = silence, ~1 = full scale).
 *  Drives the "speaking" pulse on huddle avatars. */
export function rmsLevel(samples: Uint8Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

/** Above this RMS a participant is rendered as speaking. Tuned for typical
 *  mic gain; a quiet room idles ~0.01, speech peaks well above 0.05. */
export const SPEAKING_THRESHOLD = 0.04
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/huddle-signals.test.ts src/lib/flows/__tests__/audio-level.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Unblock the microphone**

In `next.config.js` line 18, change:

```js
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
```

to:

```js
          // microphone=(self): the flows voice huddle needs getUserMedia;
          // camera and geolocation stay disabled app-wide.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
```

- [ ] **Step 6: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/lib/flows/huddle-signals.ts src/lib/flows/audio-level.ts src/lib/flows/__tests__/huddle-signals.test.ts src/lib/flows/__tests__/audio-level.test.ts next.config.js
git commit -m "feat(flows): huddle signaling policy + audio level (pure); allow same-origin microphone"
```

---

### Task 7: Voice huddle — WebRTC mesh hook + huddle bar

**Files:**
- Create: `src/lib/flows/use-flow-huddle.ts`
- Create: `src/components/flows/huddle-bar.tsx`
- Modify: `src/app/flows/[id]/page.tsx` (wire hook + render bar; remove any Task 3 `void …` placeholder line)

**Interfaces:**
- Consumes: `CollabBus`/`setInHuddle`/`participants`/`selfClientId` (Task 3), `reduceHuddleSignal`/`HuddleSignal` (Task 6), `rmsLevel`/`SPEAKING_THRESHOLD` (Task 6).
- Produces:
  - `useFlowHuddle(bus: CollabBus, selfClientId: string, setInHuddle: (v: boolean) => void): { joined: boolean; connecting: boolean; muted: boolean; speakingIds: Set<string>; join: () => Promise<void>; leave: () => void; toggleMute: () => void }`
  - `HuddleBar` component + `type HuddleMember = { clientId: string; name: string; color: string }` (used by Task 8's dialog too).

- [ ] **Step 1: Create `src/lib/flows/use-flow-huddle.ts`**

```ts
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollabBus } from '@/lib/flows/use-flow-collab'
import { reduceHuddleSignal, type HuddleSignal } from '@/lib/flows/huddle-signals'
import { rmsLevel, SPEAKING_THRESHOLD } from '@/lib/flows/audio-level'

// STUN-only v1: connects on most home/office networks. A minority behind
// strict/symmetric NATs need a TURN relay — a deliberate follow-up, not v1.
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

type PeerEntry = { pc: RTCPeerConnection; audio: HTMLAudioElement | null; analyser: AnalyserNode | null }

/**
 * P2P voice huddle over the flow's collab channel: audio-only WebRTC mesh
 * (one RTCPeerConnection per other participant — fine for the 2-5 person jams
 * this targets), signaled via the 'huddle' bus event. The pure signaling
 * policy lives in huddle-signals.ts; this hook performs the side effects.
 * Presence (`inHuddle`) is flipped via setInHuddle so avatars react.
 */
export function useFlowHuddle(
  bus: CollabBus,
  selfClientId: string,
  setInHuddle: (inHuddle: boolean) => void,
) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set())
  const peers = useRef<Map<string, PeerEntry>>(new Map())
  const localStream = useRef<MediaStream | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const localAnalyser = useRef<AnalyserNode | null>(null)
  const joinedRef = useRef(false)

  const send = useCallback((signal: Omit<HuddleSignal, 'from'>) => {
    bus.send('huddle', { ...signal, from: selfClientId })
  }, [bus, selfClientId])

  const closePeer = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry) return
    peers.current.delete(peerId)
    try { entry.pc.close() } catch { /* already closed */ }
    entry.audio?.remove()
  }, [])

  const attachAnalyser = useCallback((stream: MediaStream): AnalyserNode | null => {
    try {
      audioCtx.current ??= new AudioContext()
      const source = audioCtx.current.createMediaStreamSource(stream)
      const analyser = audioCtx.current.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      return analyser
    } catch {
      return null // no speaking pulse, audio still works
    }
  }, [])

  const createPeer = useCallback((peerId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    for (const track of localStream.current?.getTracks() ?? []) pc.addTrack(track, localStream.current!)
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ kind: 'ice', to: peerId, candidate: event.candidate.toJSON() })
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (!stream) return
      // Created after the user's explicit Join gesture, so autoplay is allowed.
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.srcObject = stream
      document.body.appendChild(audio)
      const entry = peers.current.get(peerId)
      if (entry) {
        entry.audio = audio
        entry.analyser = attachAnalyser(stream)
      }
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(peerId)
    }
    peers.current.set(peerId, { pc, audio: null, analyser: null })
    return pc
  }, [send, closePeer, attachAnalyser])

  // Signaling: run the pure policy, then perform the WebRTC side effects.
  useEffect(() => bus.on('huddle', (payload) => {
    const run = async () => {
      const signal = payload as unknown as HuddleSignal
      const instructions = reduceHuddleSignal(selfClientId, joinedRef.current, Array.from(peers.current.keys()), signal)
      for (const instruction of instructions) {
        try {
          if (instruction.action === 'create-offer') {
            const pc = createPeer(instruction.peerId)
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            send({ kind: 'offer', to: instruction.peerId, sdp: offer })
          } else if (instruction.action === 'apply-offer') {
            const pc = peers.current.get(instruction.peerId)?.pc ?? createPeer(instruction.peerId)
            await pc.setRemoteDescription(instruction.sdp as RTCSessionDescriptionInit)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            send({ kind: 'answer', to: instruction.peerId, sdp: answer })
          } else if (instruction.action === 'apply-answer') {
            await peers.current.get(instruction.peerId)?.pc.setRemoteDescription(instruction.sdp as RTCSessionDescriptionInit)
          } else if (instruction.action === 'add-ice') {
            await peers.current.get(instruction.peerId)?.pc.addIceCandidate(instruction.candidate as RTCIceCandidateInit)
          } else {
            closePeer(instruction.peerId)
          }
        } catch {
          // One bad peer or stale signal must not break the rest of the mesh.
        }
      }
    }
    void run()
  }), [bus, selfClientId, createPeer, closePeer, send])

  const join = useCallback(async () => {
    if (joinedRef.current) return
    setConnecting(true)
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      localAnalyser.current = attachAnalyser(localStream.current)
      joinedRef.current = true
      setJoined(true)
      setMuted(false)
      setInHuddle(true)
      send({ kind: 'join' }) // existing members respond with offers
    } catch {
      // Mic denied or unavailable — stay out of the huddle.
    } finally {
      setConnecting(false)
    }
  }, [send, setInHuddle, attachAnalyser])

  const leave = useCallback(() => {
    if (!joinedRef.current) return
    joinedRef.current = false
    setJoined(false)
    send({ kind: 'leave' })
    for (const peerId of Array.from(peers.current.keys())) closePeer(peerId)
    localStream.current?.getTracks().forEach((track) => track.stop())
    localStream.current = null
    localAnalyser.current = null
    setInHuddle(false)
    setSpeakingIds(new Set())
  }, [send, closePeer, setInHuddle])

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current
      localStream.current?.getAudioTracks().forEach((track) => { track.enabled = !next })
      return next
    })
  }, [])

  // Speaking pulse: sample all analysers 4×/s; update only on change.
  useEffect(() => {
    if (!joined) return
    const buffer = new Uint8Array(256)
    const timer = window.setInterval(() => {
      const next = new Set<string>()
      if (localAnalyser.current) {
        localAnalyser.current.getByteTimeDomainData(buffer)
        if (rmsLevel(buffer) > SPEAKING_THRESHOLD) next.add(selfClientId)
      }
      for (const [peerId, entry] of peers.current) {
        if (!entry.analyser) continue
        entry.analyser.getByteTimeDomainData(buffer)
        if (rmsLevel(buffer) > SPEAKING_THRESHOLD) next.add(peerId)
      }
      setSpeakingIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
    }, 250)
    return () => window.clearInterval(timer)
  }, [joined, selfClientId])

  // Leave cleanly on unmount/navigation (ref pattern: the cleanup must run
  // once at unmount, not every time leave's identity changes).
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => () => { if (joinedRef.current) leaveRef.current() }, [])

  return { joined, connecting, muted, speakingIds, join, leave, toggleMute }
}
```

- [ ] **Step 2: Create `src/components/flows/huddle-bar.tsx`**

```tsx
'use client'

import { Headphones, Loader2, Mic, MicOff, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type HuddleMember = { clientId: string; name: string; color: string }

/**
 * Floating voice-huddle controls, shown whenever a huddle is live (self or
 * teammates in it): join/leave, mute, and member avatars with a speaking
 * pulse. Sits bottom-center over the canvas.
 */
export function HuddleBar({
  joined,
  connecting,
  muted,
  members,
  speakingIds,
  onJoin,
  onLeave,
  onToggleMute,
}: {
  joined: boolean
  connecting: boolean
  muted: boolean
  /** Everyone currently in the huddle (including self when joined). */
  members: HuddleMember[]
  speakingIds: Set<string>
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
}) {
  if (!joined && members.length === 0) return null
  return (
    <div className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
      <span className="flex items-center gap-1.5 pr-1 text-xs font-semibold text-muted-foreground">
        <Headphones className="h-3.5 w-3.5" /> Huddle
      </span>
      <div className="flex items-center -space-x-1.5">
        {members.slice(0, 6).map((member) => (
          <span
            key={member.clientId}
            title={member.name}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white transition-shadow',
              speakingIds.has(member.clientId) && 'ring-2 ring-emerald-400',
            )}
            style={{ backgroundColor: member.color }}
          >
            {member.name.trim().charAt(0).toUpperCase() || '?'}
          </span>
        ))}
        {members.length > 6 && (
          <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
            +{members.length - 6}
          </span>
        )}
      </div>
      {joined ? (
        <>
          <Button variant={muted ? 'default' : 'outline'} size="sm" className="rounded-full" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <Button variant="destructive" size="sm" className="rounded-full" onClick={onLeave} aria-label="Leave huddle">
            <PhoneOff className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <Button size="sm" className="rounded-full" onClick={onJoin} disabled={connecting}>
          {connecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Mic className="mr-1.5 h-4 w-4" />} Join
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire the page**

In `src/app/flows/[id]/page.tsx`:

1. Add imports:

```ts
import { useFlowHuddle } from '@/lib/flows/use-flow-huddle'
import { HuddleBar } from '@/components/flows/huddle-bar'
```

2. After the autosave block (Task 5), add:

```ts
  // ── Voice huddle ────────────────────────────────────────────────────────────
  const huddle = useFlowHuddle(bus, selfClientId, setInHuddle)
  // Everyone whose presence says they're in the huddle (incl. self once joined).
  const huddleMembers = useMemo(
    () => participants.filter((p) => p.inHuddle).map((p) => ({ clientId: p.clientId, name: p.name, color: p.color })),
    [participants],
  )
```

3. Inside the body container `<div className="relative flex min-h-0 flex-1">` (~line 1256), directly after its opening tag, render:

```tsx
        <HuddleBar
          joined={huddle.joined}
          connecting={huddle.connecting}
          muted={huddle.muted}
          members={huddleMembers}
          speakingIds={huddle.speakingIds}
          onJoin={() => void huddle.join()}
          onLeave={huddle.leave}
          onToggleMute={huddle.toggleMute}
        />
```

4. If Task 3's temporary `void …` placeholder line still exists, delete it — every destructured value is now consumed.

- [ ] **Step 4: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-bar.tsx src/app/flows/[id]/page.tsx
git commit -m "feat(flows): P2P voice huddle — WebRTC mesh over the collab channel, floating huddle bar"
```

---

### Task 8: Jam dialog rebuild + arrival cue

Rebuild the dialog so it reads as a live session and the reported layout breakage (link overflow, washed-out disabled send bar, radio spacing) is gone; announce arrivals so an invitee feels the session.

**Files:**
- Modify: `src/components/flows/jam-dialog.tsx` (full-file replacement below)
- Modify: `src/app/flows/[id]/page.tsx` (new dialog props + arrival toasts)

**Interfaces:**
- Consumes: presence/others (Task 3), `huddle.join` + `huddle.joined` (Task 7).
- Produces: `JamDialog` props change — `presence` entries gain `color` and `inHuddle`, and two new optional props: `onJoinHuddle?: () => void`, `huddleJoined?: boolean`.

- [ ] **Step 1: Replace `src/components/flows/jam-dialog.tsx` with:**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Check, Copy, Link2, Mic, Send, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Visibility = 'shared' | 'view' | 'private'
type Member = { id: string; name: string | null; email: string | null }

const OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'shared', label: 'Everyone can edit', hint: 'Anyone in your workspace can jam on and run this flow.' },
  { value: 'view', label: 'Everyone can view, only you edit', hint: 'Your workspace can open and run it; only you make changes.' },
  { value: 'private', label: 'Only you', hint: 'Just you can see this flow.' },
]

/**
 * Jam: the flow's live-session surface — who's here now (with a voice-huddle
 * entry point), the invite link, teammate invites, and access control. The
 * invite link points straight at the flow (/flows/<id>); login return_to
 * lands an invitee here, and their invite notification deep-links here too.
 */
export function JamDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
  visibility,
  canEdit,
  onChangeVisibility,
  presence,
  onJoinHuddle,
  huddleJoined,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  flowName: string
  visibility: Visibility
  canEdit: boolean
  onChangeVisibility: (next: Visibility) => void
  /** Who else is currently in this flow, if presence is live. */
  presence?: { id: string; name: string; color?: string; inHuddle?: boolean }[]
  /** Starts/joins the voice huddle (closes the dialog first at the call site). */
  onJoinHuddle?: () => void
  huddleJoined?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/flows/${flowId}` : `/flows/${flowId}`
  const shareable = visibility !== 'private'
  const canInvite = canEdit && shareable
  const here = presence ?? []
  const huddleLive = here.some((p) => p.inHuddle)

  // Load workspace members to invite (once the dialog opens, for editors of a
  // shareable flow).
  useEffect(() => {
    if (!open || !canInvite) return
    let cancelled = false
    fetch('/api/organizations/members', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && data.success) setMembers(data.members ?? []) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [open, canInvite])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const sendInvites = async () => {
    if (selected.size === 0) return
    setSending(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(selected) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not send invites.')
        return
      }
      toast.success(`Invited ${data.invited} ${data.invited === 1 ? 'person' : 'people'} — they’ll get a notification linking to this flow.`)
      setSelected(new Set())
    } finally {
      setSending(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      toast.success('Invite link copied')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-600" />
            <span className="min-w-0 truncate">Jam on “{flowName || 'this flow'}”</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {here.length > 0 && (
            <div className="rounded-xl border border-indigo-200/70 bg-indigo-50/50 p-3 dark:border-indigo-500/25 dark:bg-indigo-500/10">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-800 dark:text-indigo-200">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  In this jam now
                </p>
                {onJoinHuddle && !huddleJoined && (
                  <Button size="sm" variant="outline" className="h-7 rounded-full" onClick={onJoinHuddle}>
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    {huddleLive ? 'Join huddle' : 'Start huddle'}
                  </Button>
                )}
                {huddleJoined && (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <Mic className="h-3.5 w-3.5" /> In huddle
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {here.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs">
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ backgroundColor: p.color || '#6366f1' }}
                    >
                      {p.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    {p.name}
                    {p.inHuddle && <Mic className="h-3 w-3 text-emerald-600" />}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Invite link</p>
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-3 pr-1">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{inviteLink}</span>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={copy}>
                {copied ? <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone you send this to opens straight into this flow after signing in. They can jam based on the access below.
            </p>
          </div>

          {canInvite && members.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Invite teammates</p>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
                {members.map((m) => {
                  const label = m.name || m.email || 'Teammate'
                  const checked = selected.has(m.id)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-indigo-500 bg-indigo-500' : 'border-muted-foreground/40')}>
                        {checked && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  )
                })}
              </div>
              {selected.size > 0 ? (
                <Button size="sm" className="w-full" onClick={sendInvites} loading={sending}>
                  <Send className="mr-1.5 h-4 w-4" />
                  Send invite to {selected.size} {selected.size === 1 ? 'teammate' : 'teammates'}
                </Button>
              ) : (
                <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-center text-xs text-muted-foreground">
                  Select teammates above to send invites.
                </p>
              )}
            </div>
          )}
          {canEdit && !shareable && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
              This flow is private. Set it to “Everyone can view” or “edit” below to invite teammates.
            </p>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Who can access</p>
            {canEdit ? (
              <div className="space-y-1.5">
                {OPTIONS.map((option) => {
                  const active = visibility === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onChangeVisibility(option.value)}
                      aria-pressed={active}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                        active
                          ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/10'
                          : 'border-border/70 hover:bg-accent',
                      )}
                    >
                      <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-indigo-500 bg-indigo-500' : 'border-muted-foreground/40')}>
                        {active && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{option.label}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{option.hint}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-border/70 bg-muted/40 p-3 text-sm text-muted-foreground">
                {OPTIONS.find((o) => o.value === visibility)?.hint ?? 'Only the owner can change who can access this flow.'}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Update the dialog call site + arrival cue in `src/app/flows/[id]/page.tsx`**

1. Replace the `<JamDialog … />` render (~line 1474) with:

```tsx
      <JamDialog
        open={showJam}
        onOpenChange={setShowJam}
        flowId={id}
        flowName={name}
        visibility={visibility as 'shared' | 'view' | 'private'}
        canEdit={canEdit}
        onChangeVisibility={(next) => void updateSharing(next)}
        presence={others.map((p) => ({ id: p.clientId, name: p.name, color: p.color, inHuddle: p.inHuddle }))}
        onJoinHuddle={() => { setShowJam(false); void huddle.join() }}
        huddleJoined={huddle.joined}
      />
```

2. After the `others` memo in the collab block, add the arrival cue:

```ts
  // Arrival cue: opening a flow where a jam is live (or a teammate joining
  // yours) is announced once per client — an invitee lands INSIDE a session,
  // not on a silent canvas.
  const seenJamClients = useRef<Set<string>>(new Set())
  const announcedJam = useRef(false)
  useEffect(() => {
    if (others.length === 0) return
    if (!announcedJam.current) {
      announcedJam.current = true
      for (const p of others) seenJamClients.current.add(p.clientId)
      toast(`Jam in progress — ${others.length === 1 ? `${others[0].name} is` : `${others.length} people are`} here`, {
        action: { label: 'View', onClick: () => setShowJam(true) },
      })
      return
    }
    for (const p of others) {
      if (!seenJamClients.current.has(p.clientId)) toast(`${p.name} joined the jam`)
      seenJamClients.current.add(p.clientId)
    }
  }, [others])
```

- [ ] **Step 3: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/components/flows/jam-dialog.tsx src/app/flows/[id]/page.tsx
git commit -m "feat(flows): jam dialog reads as a live session — presence + huddle entry, fixed layout, arrival cues"
```

---

### Task 9: Full gates + live verification on a Vercel preview

**Files:** none created — verification only.

- [ ] **Step 1: Full local gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, zero warnings introduced.

- [ ] **Step 2: CI-mode check**

Per the repo's workflow, reproduce the CI gate (DB-backed tests + build) before pushing — use the local Postgres `ci_repro` procedure if available, otherwise push and watch GitHub Actions. The new migration (`notification_link`) must apply cleanly via `prisma migrate deploy`.

- [ ] **Step 3: Push and verify live with two browser sessions on the deployment**

Checklist (two different signed-in users of the same org, same flow):

1. **Invite deep link:** user A opens Jam → invites user B → B's notification bell entry navigates to `/flows/<id>` (NOT `/dashboard`).
2. **Arrival cue:** B lands on the flow and sees "Jam in progress — <A> is here"; A sees "<B> joined the jam".
3. **Cursors:** each sees the other's named, colored cursor move; parked cursors sit on the same node at different zoom levels; idle cursors fade in ~5s.
4. **Editing rings:** B selects a node → A sees the colored ring + "<B> editing" chip on that node.
5. **Live edits:** A adds/edits/deletes steps → B sees them within ~200ms, and vice versa; concurrent edits to different nodes both survive.
6. **Autosave:** with both editing, reload B after ~5s idle — the merged graph is persisted; NO "a teammate saved — reloading" toast appears for either during the jam; the activity timeline shows coalesced (not per-tick) edit audits.
7. **Huddle:** A starts a huddle from the Jam dialog (browser prompts for mic — Permissions-Policy allows it); B sees the huddle bar appear and joins; both hear each other; speaking pulses track; mute silences; leave tears down cleanly (no lingering mic indicator).
8. **View-only:** set the flow to "Everyone can view, only you edit" — the viewer gets cursors/presence/huddle but no graph edits and never autosaves.
9. **Jam dialog:** no link overflow, no washed-out disabled bar, radio cards aligned — compare against the reported screenshot.

- [ ] **Step 4: Note results in the ledger**

Record outcomes (including any STUN-connectivity failures observed — expected for symmetric-NAT users, TURN is the documented follow-up) in `.superpowers/sdd/progress.md`.
