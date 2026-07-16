# Flows Jam — Real-Time Multiplayer Design

**Date:** 2026-07-16
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel

## Problem

The "Jam" feature today is a sharing/invite shell layered over org-wide flow
visibility. It does not deliver the collaborative experience it implies. Concretely:

1. **Invite navigation is broken.** The in-app notification bell rebuilds its href
   from `executionId`, which is `null` for jam invites, so clicking a jam-invite
   notification lands on `/dashboard` instead of the invited flow. Only the browser
   web-push payload carries the correct `/flows/<id>` deep link.
2. **No live cursors.** Only graph-ops and presence are broadcast on the realtime
   channel; cursor coordinates are never sent, so collaborators can't see each other
   move on the canvas.
3. **No voice huddle at all**, and it is actively blocked by a global
   `Permissions-Policy: microphone=()` response header that disables the mic
   app-wide.
4. **Edits persist only on manual save** (a full-graph `PUT` guarded by an
   `updatedAt` optimistic lock), producing the "a teammate saved — reloading…"
   clash. Live sync is ephemeral; durability is single-writer.
5. **The Jam dialog UI is misaligned** (invite-link overflow, disabled-bar styling,
   radio-card spacing) and reads as a share sheet, not a live session.

## What already exists (the foundation we build on)

- **Supabase Realtime is already wired.** `src/lib/flows/use-flow-collab.ts` opens a
  single channel `flow:${flowId}` carrying **presence** (`{ clientId, userId, name,
  color }`, feeding the avatar stack + Jam "here now") and **op-based graph
  broadcast** (`diffGraph`/`applyGraphOps` in `src/lib/flows/graph-ops.ts`, throttled
  200ms, 200KB cap, full-state bootstrap for new joiners). Live edits already
  propagate node/edge changes.
- The browser connects **directly to Supabase's hosted WebSocket servers**, bypassing
  Vercel — the only viable pattern here, since Vercel serverless can't hold sockets.
- The flow canvas is a **custom vertical DOM "chain"** of `StepCard`s
  (`src/components/flows/flow-canvas.tsx`), **not** React Flow (the `@xyflow/react`
  package is installed but unreferenced). There is a pan/zoom transform
  (`src/components/flows/use-canvas-pan.ts`, zoom persisted to `localStorage` as
  `flows.canvasZoom`). Cursor overlays therefore map to canvas **content-space**
  coordinates, not a React Flow viewport.
- Graph state is plain `useState` in `src/app/flows/[id]/page.tsx`; persistence is a
  **manual full-graph `PUT /api/flows`** with an optimistic lock (`baseUpdatedAt` vs.
  `existing.updatedAt` → `409 FLOW_STALE_WRITE`). The whole graph is a single `Json`
  column on `Flow`.
- Auth is Supabase; org membership is a `User.organizationId` FK; per-flow access is
  `agentVisibilityScope(userId)` + a free-string `Flow.visibility`
  (`shared | view | private`), with `canEditFlow`/`assertFlowEditable` in
  `src/lib/flows/access.ts`.

## Decisions (locked)

| Fork | Decision | Rationale |
|---|---|---|
| Real-time engine | **Extend Supabase Realtime** | Already wired; zero new vendors/cost; fastest; fits architecture. |
| Voice huddle | **P2P WebRTC mesh over Supabase signaling** | Zero new infra; good for small jams (~2–5 people). |
| Edit durability | **Autosave during a jam** | Removes the "teammate saved — reloading" clash. |

Not chosen (and why): Liveblocks / Yjs (new vendor or heavy integration; user chose to
extend Supabase); managed SFU / TURN (new infra; STUN-only v1); external token
share-links + collaborator-membership table (bigger access-model change; access stays
org + visibility for v1).

## Architecture overview

Everything rides the **one** existing `flow:${flowId}` Supabase Realtime channel. We
add new broadcast events and presence fields to it — no second channel (Supabase
counts channels), no new backend service. Backend touches are limited to:

- a nullable `Notification.link` column + persistence (invite deep-link fix),
- an autosave path reusing `PUT /api/flows` (no new endpoint),
- relaxing one response header (`microphone=(self)`).

Channel event map after this work:

| Event / field | Direction | Purpose | Status |
|---|---|---|---|
| presence `{clientId,userId,name,color}` | track/sync | who's here | exists |
| presence `+ selection: nodeId?` | track/sync | who's editing which node | new |
| presence `+ inHuddle: bool` | track/sync | who's in the voice huddle | new |
| broadcast `graph` `{clientId,ops}` | send/recv | live edit sync | exists |
| broadcast `bootstrap` (full state) | send/recv | new-joiner + resync | exists (extend for resync) |
| broadcast `cursor` `{clientId,x,y,name,color}` | send/recv | live cursors | new |
| broadcast `saved` `{updatedAt}` | send/recv | advance optimistic base after autosave | new |
| broadcast `huddle-join/leave/offer/answer/ice` | send/recv | WebRTC signaling | new |

## Section 1 — Invite navigation

**Goal:** an invited teammate clicking the invite (link or in-app notification) lands
on the exact flow, and arriving feels like joining a live session.

- **Schema:** add `link String?` (nullable, default null) to the `Notification` model
  (`prisma/schema.prisma`) via a small migration.
- **Persist it:** `notify()` (`src/lib/notifications/service.ts`) writes `link` to the
  row (today it only forwards `link` into the web-push payload).
- **Route from it:** `notificationHref()`
  (`src/components/notifications/notification-bell.tsx`) prefers `n.link` before the
  `executionId`-based fallback. This also repairs future deep-links generally.
- **Arrival cue:** when a user lands on `/flows/<id>` and presence shows others
  present, surface a "Jam in progress — N here" affordance and auto-open the
  presence/huddle surface, so arriving reads as joining a session.
- **Out of scope (flagged, not half-built):** external/token share-links and a
  collaborator-membership table. Access remains org-membership + `Flow.visibility`,
  which already governs who can open (`shared`/`view`) or edit (`shared`, or owner for
  `view`). A `private` flow's invite is already rejected server-side.

**Testable units:** `notify()` persists `link`; `notificationHref()` prefers it.

## Section 2 — Live cursors + editing presence

**Goal:** collaborators see each other's cursors move on the canvas and see who is
editing which step.

- **Cursor broadcast:** new `cursor` event on the shared channel,
  `{ clientId, x, y, name, color }`, where `(x, y)` are in canvas **content-space**
  (un-transformed). A cursor parked on a node shows on that node for every viewer
  regardless of their own pan/zoom.
  - Send: on pointer move over the canvas, convert client coords → content coords
    using the canvas rect + current pan + zoom; throttle to ~40ms (rAF/interval
    coalesced); skip when unchanged.
  - Render: a `cursor-layer.tsx` overlay mounted **inside** the transformed content
    layer, positioning each remote cursor at its content-space `(x, y)` so it inherits
    the same pan/zoom transform. Colored pointer + name label (reusing
    `presenceColor`), CSS-interpolated for smoothness, fades after ~5s idle or on
    presence-leave.
- **Editing presence:** add a `selection: nodeId | null` field to the presence
  payload. Render a colored ring + "<name> is editing" badge on the corresponding
  `StepCard` (which already carries `data-node-id`). This is the anti-clobber cue.
- **Files:** extend `use-flow-collab.ts` to carry cursor + selection on the *same*
  channel and expose `{ others, cursors, selections, sendCursor, setSelection }`; add
  `src/components/flows/cursor-layer.tsx`.

**Testable units:** the pure client→content coordinate transform; presence merge of
`selection`.

## Section 3 — Autosave + edit-sync hardening

**Goal:** the flow is always saved during a jam, with no optimistic-lock clash, and
sync heals after network blips.

- **Single elected persister.** Because all peers already share the merged graph via
  broadcast, only *one* client writes to Postgres. Elect a persister deterministically:
  the flow owner if present and an editor, else the lowest `clientId` among present
  editors. The persister debounce-autosaves (~2s after the last local edit, while a
  jam is active and the graph is dirty) via the existing `PUT /api/flows`. On success
  it broadcasts `{ event: 'saved', updatedAt }`; every client sets
  `baseUpdatedAt.current = updatedAt`. Result: one writer, **zero** optimistic-lock
  contention during a jam. Re-elect when the persister leaves.
  - Solo (no other participants): the sole editor is the persister; behaves like
    normal autosave.
  - View-only participants never persist and never autosave.
- **Resync on reconnect:** on channel resubscribe after a blip, a client requests a
  full-state `bootstrap` so drift heals (extends the existing bootstrap path).
- **Audit hygiene:** autosave suppresses the per-edit `flow.edited` audit spam and
  instead records one coalesced "jam edited" audit (e.g. on a longer interval or on
  jam end), so the activity timeline isn't flooded.
- **Manual Save stays** as a safety button; during a jam it's largely redundant.
- **Accepted v1 tradeoff:** graph merge is node-granular last-write-wins (not
  field-level CRDT). Two people editing the *same* node's config can clobber; the
  editing-presence ring (Section 2) mitigates this. This is the direct consequence of
  extending Supabase Realtime rather than adopting a CRDT.

**Testable units:** persister election (pure function over the present-participant
set); `saved`-event advances `baseUpdatedAt`; autosave debounce/dirty gating.

## Section 4 — Voice huddle (P2P WebRTC mesh)

**Goal:** anyone in a jam can start/join a voice huddle from the flow.

- **Unblock the mic:** relax the global response header (`next.config.js`) from
  `microphone=()` to `microphone=(self)`; keep `camera=()` and `geolocation=()` off.
  Leave the strict CSP / `X-Frame-Options` posture intact (WebRTC uses STUN, not an
  HTTP origin we need to allowlist for v1).
- **Signaling** over the same channel: `huddle-join`, `huddle-leave`, `huddle-offer`,
  `huddle-answer`, `huddle-ice`. **Mesh topology** — each participant maintains one
  `RTCPeerConnection` per other participant; audio-only. Fine for ~2–5-person jams.
- **Presence + speaking:** presence carries `inHuddle: boolean`. A WebAudio analyser
  on each stream drives a "speaking" pulse on the corresponding avatar. Mute = disable
  the local audio track.
- **UI:** a floating **huddle bar** (`src/components/flows/huddle-bar.tsx`) with
  join/leave, mute toggle, and participant chips. Remote audio elements play on the
  user's Join gesture (satisfies autoplay policy). Peer connections close on
  leave/unmount/presence-leave.
- **Files:** `src/lib/flows/use-flow-huddle.ts` (mesh + signaling on the shared
  channel), `huddle-bar.tsx`.
- **Honest caveat — STUN-only v1.** Uses public STUN only. It connects on most
  home/office networks but will fail for a minority behind strict/symmetric NATs,
  which need a **TURN relay** (new infra). TURN is a deliberate reliability follow-up,
  not part of v1. We ship STUN-only and say so, rather than imply it's bulletproof.

**Testable units:** signaling state reducers (join/leave/offer/answer/ice → peer
map); mute toggles the track's `enabled`.

## Section 5 — Jam UI polish

**Goal:** the Jam surface reads as a live session and the reported visual breakage is
gone.

- Rebuild `src/components/flows/jam-dialog.tsx`: fix invite-link overflow, the
  disabled "Select teammates to invite" bar, and radio-card spacing/alignment shown in
  the reported screenshot. Follow existing component patterns and the motion-depth
  primitives already in the repo; no raw token/`{{}}` syntax in any copy.
- Cohesive pass on the presence avatar stack, cursor name tags, and the huddle bar so
  live state (here-now, editing, in-huddle, speaking) reads as one system.
- The toolbar "Jam" button reflects live session state (it already shows a presence
  count badge).

## Testing strategy

- **Unit tests** (extend the existing `graph-ops` / `use-flow-collab` test suites) for
  every pure unit named above: cursor coordinate transform, persister election,
  `saved`-event base advancement, huddle signaling reducers, notification-link href,
  mute behavior.
- **Live verification** on a Vercel preview with two browser sessions (local dev
  cannot exercise this — no Supabase env vars locally by design): cursors track, edits
  sync both ways, autosave persists with no reload-clash, invite notification lands on
  the flow, huddle connects and audio flows, mute works.
- **Gates before push:** `tsc`, lint, unit tests, CI-mode DB-backed run.

## Out of scope (YAGNI for v1)

- External / non-org token share-links and a per-flow collaborator-membership model
  (access stays org + `visibility`).
- Managed SFU and TURN relay infrastructure (STUN-only v1).
- Video, screen-share, and huddle recording.
- Canvas comments/threads.
- Full CRDT (Yjs) field-level merge for node config (node-level last-write-wins + the
  editing-presence cue is the v1 tradeoff).

## Suggested build sequence

Each phase is independently shippable:

1. **Invite navigation** (Section 1) — quick, high-impact fix.
2. **Live cursors + editing presence** (Section 2).
3. **Autosave + sync hardening** (Section 3).
4. **Voice huddle** (Section 4).
5. **Jam UI polish** (Section 5).

## Key files

| Concern | Path |
|---|---|
| Realtime collab hook (extend) | `src/lib/flows/use-flow-collab.ts` |
| Op merge | `src/lib/flows/graph-ops.ts` |
| Flow editor page (wiring) | `src/app/flows/[id]/page.tsx` |
| Canvas renderer | `src/components/flows/flow-canvas.tsx` |
| Pan/zoom | `src/components/flows/use-canvas-pan.ts` |
| Jam dialog (rebuild) | `src/components/flows/jam-dialog.tsx` |
| Cursor overlay (new) | `src/components/flows/cursor-layer.tsx` |
| Huddle hook + bar (new) | `src/lib/flows/use-flow-huddle.ts`, `src/components/flows/huddle-bar.tsx` |
| Save API (reuse for autosave) | `src/app/api/flows/route.ts` |
| Invite API | `src/app/api/flows/[id]/invite/route.ts` |
| Notification service + model | `src/lib/notifications/service.ts`, `prisma/schema.prisma` |
| Notification bell | `src/components/notifications/notification-bell.tsx` |
| Mic Permissions-Policy header | `next.config.js` |
| Access helpers | `src/lib/flows/access.ts`, `src/lib/server/visibility.ts` |
