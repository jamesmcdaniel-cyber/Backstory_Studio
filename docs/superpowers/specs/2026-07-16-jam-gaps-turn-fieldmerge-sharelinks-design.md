# Jam v1.5 — TURN Relay, Field-Level Merge, External Share Links

**Date:** 2026-07-16
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel
**Predecessor:** `2026-07-16-flows-jam-realtime-multiplayer-design.md` (shipped at 66d3cd0). This spec closes that spec's three documented v1 gaps.

## Problem

Jam v1 shipped with three deliberate cuts, now to be closed:

1. **STUN-only voice** — the huddle fails to connect for users behind
   strict/symmetric NATs; it needs a TURN relay path.
2. **Node-level last-write-wins merge** — two people editing the *same* step's
   config clobber each other (`diffGraph` treats a node as one atomic value);
   the editing ring only mitigates.
3. **Invites grant nothing** — access is still org-membership + `visibility`.
   There is no way to jam with someone outside the workspace, and "accepting"
   an invite creates no durable record.

## Decisions (locked)

| Fork | Decision | Rationale |
|---|---|---|
| TURN | **Env-configured, auth-gated ICE endpoint; STUN fallback** | No vendor lock, no client-side creds, zero behavior change until env vars are set. |
| Field merge | **Per-field diff of `node.data` in graph-ops** (no Yjs) | Fixes the real clobber case with a small extension to the proven op-merge layer. |
| External share | **Tokenized link + collaborator table; view/jam-edit only — no run/publish/runs/history for guests** | Delivers cross-workspace jamming while execution and billing never leave the owning org. |

## Section 1 — TURN relay (env-configured)

- **Pure helper** `iceServersFromEnv(env)` in `src/lib/flows/ice-config.ts`:
  always returns Google STUN (`stun:stun.l.google.com:19302`); when
  `TURN_URL` (comma-separated URLs allowed), `TURN_USERNAME`, and
  `TURN_CREDENTIAL` are all set, appends
  `{ urls: [...], username, credential }`. Partial config → STUN-only (no
  half-configured relay).
- **Endpoint** `GET /api/flows/huddle-ice` (wrapped in `withAuthenticatedApi`
  like every flows route): returns `{ success: true, iceServers }`. Creds
  therefore reach only authenticated users at call time and never ship in the
  bundle.
- **Hook** `useFlowHuddle.join()` fetches the endpoint once per join (cached in
  a ref) *before* `getUserMedia`/peer creation and passes the result to every
  `RTCPeerConnection`. Any fetch failure falls back to the current hardcoded
  STUN config — the huddle never breaks because the endpoint is unreachable.
- **Ops:** to enable relay, set the three env vars in Vercel (any vendor:
  Twilio/Metered/Cloudflare/coturn). No code change. Until then behavior is
  identical to v1.

## Section 2 — Field-level merge for same-node edits

- **Op shape:** `GraphOps` gains
  `patchNodes?: { id: string; set?: Record<string, unknown>; unset?: string[] }[]`.
- **`diffGraph`:** for a node whose id exists in both graphs with the **same
  `type`**, shallow-diff the top-level keys of `node.data`. If anything
  changed, emit a `patchNodes` entry (`set` = added/changed keys, `unset` =
  removed keys) instead of a full upsert. Changed `type` (or a brand-new node)
  keeps the existing full-upsert path. Key values compare by JSON identity
  (same `same()` helper) — arrays/nested objects within one field stay atomic.
- **`applyGraphOps`:** a patch merges into the local node:
  `{ ...node, data: { ...node.data, ...set } }` with `unset` keys removed.
  A patch for a node absent locally is a **no-op** (a concurrent delete wins).
  `isEmptyOps` accounts for `patchNodes`.
- **Effect:** editing different fields of the same step concurrently now
  merges cleanly; only the *same field* remains last-write-wins (the editing
  ring covers that). Node/edge add/remove semantics are unchanged.
- **Compatibility caveat (accepted):** during a deploy window, a stale client
  ignores `patchNodes` and misses those edits until the next full bootstrap
  (join/reconnect) heals it. Both editors on the current deploy converge.

## Section 3 — External share links + collaborator table

### Data model (one migration)

```prisma
model FlowCollaborator {
  id        String   @id @default(cuid())
  flowId    String
  userId    String
  role      String   @default("edit") // 'edit' | 'view'
  createdAt DateTime @default(now())
  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)
  @@unique([flowId, userId])
  @@index([userId])
  @@map("flow_collaborators")
}
```

`Flow` gains `shareToken String? @unique` and `shareRole String @default("view")`
(`'view' | 'edit'`), plus the `collaborators` relation. Share is "enabled" iff
`shareToken != null`.

### Access resolution (pure, tested)

`resolveFlowRole(flow, viewer, shareToken?)` in `src/lib/flows/access.ts`
returns `'edit' | 'view' | null`:

1. **Same org:** exactly today's semantics — `private` → owner only (edit);
   `view` → owner edits, org views; `shared` → org edits. (Legacy ownerless
   flows stay org-editable.)
2. **Cross-org collaborator row:** that row's role.
3. **Valid `shareToken` match:** `flow.shareRole`.
4. Otherwise `null`.

Owner is always `edit`. `canEditFlow`/`assertFlowEditable` keep their existing
signatures for same-org callers; role-aware paths use `resolveFlowRole`.

### Server surface

- **`POST /api/flows/[id]/share`** — same-org editors only (guests can never
  manage sharing). Body `{ enabled: boolean, role: 'view' | 'edit' }`:
  enabling mints a fresh 32-hex token (`crypto.randomBytes(16)`) — enabling
  again **rotates** (revokes old links); disabling nulls the token. Audited
  (`flow.share_link`). Returns `{ shareToken, shareRole }`.
- **`GET /api/flows/[id]?share=<token>`** — NEW single-flow endpoint (no
  `[id]/route.ts` exists today). Loads the flow **by id, not org-scoped**,
  resolves the viewer's role (org / collaborator / token). `null` → 404.
  **Acceptance:** a valid token for a cross-org viewer with no collaborator
  row upserts `FlowCollaborator` (their durable grant — subsequent opens need
  no token). Same-org viewers never get rows (already covered by visibility).
  Returns the serialized flow.
- **`GET /api/flows`** (list) — adds collaborated flows:
  `OR: [{ organizationId, ...agentVisibilityScope }, { collaborators: { some: { userId } } }]`.
- **`PUT /api/flows`** — lookup by id with the viewer's collaborator row;
  require role `edit` via `resolveFlowRole`. **Cross-org editors may write the
  graph only** — `name/description/status/visibility/folder/trigger` writes
  from a guest → 403 with plain English. Optimistic lock, autosave,
  `suppressAudit` all work unchanged for guests.
- **Execution wall (defense in depth):** execute/publish/runs/versions/
  trigger-secret routes stay org-scoped exactly as today — a guest hitting
  them gets 404/403 even by hand-crafted request.

### Serialization + client

- `serializeFlow` gains a role-aware form: `role` (`edit|view`),
  `external: boolean` (viewer org ≠ flow org), and — **for same-org editors
  only** — `shareToken`/`shareRole` so the dialog can render link state.
  `canEdit` is derived from `role` (back-compat preserved for org callers).
- **Builder page:** keeps the list-based load; when the flow isn't in the list
  OR `?share=` is present, falls back to `GET /api/flows/[id]?share=…` (the
  acceptance path). Guests (`external`) get: Run/Publish/Runs/History/Copilot*
  hidden, a persistent "Guest access — running and publishing stay with the
  owning workspace." notice, and the full jam surface (cursors, presence,
  huddle; graph edits + autosave when role is `edit`). Presence `canEdit`
  flag = `role === 'edit'`, so persister election naturally includes editing
  guests. (*Copilot mutates via the same graph path; hidden for guests in
  v1.5 to keep the write surface exactly "the canvas".)
- **Jam dialog:** new "Anyone with the link" section for same-org editors —
  enable toggle, view/edit picker, tokenized link
  (`/flows/<id>?share=<token>`), Rotate button with plain-English revocation
  copy. The invite-link row shows the tokenized link when sharing is enabled,
  else the plain org link. No raw token/bracket syntax in any copy.
- **Login flow:** middleware already preserves `?share=` through
  `return_to` (`${pathname}${request.nextUrl.search}`) — an invited outsider
  signs in/up and lands on the flow with the token intact; the self-healing
  provisioner gives them an org, and acceptance upserts their collaborator row.

### Honest constraints (documented, not hidden)

- Guests must be **entitled platform users** — the global prod gates
  (entitlement + MCP-connected) apply to every API call. This is
  cross-workspace sharing, not anonymous public links.
- A rotated/disabled token does **not** revoke existing collaborator rows
  (they were accepted grants); v1.5 has no collaborator-removal UI — deferred.
- The Supabase Realtime channel itself is not token-gated (as in v1); durable
  reads/writes are.

## Testing

- Pure units (node:test, as established): `iceServersFromEnv` matrix,
  `diffGraph`/`applyGraphOps` patch cases (field change → patch; type change →
  upsert; disjoint-field concurrent merge; unset; deleted-node no-op;
  `isEmptyOps`), `resolveFlowRole` matrix (org × visibility × collaborator ×
  token × owner).
- DB-backed test (CI / ci_repro, patterned on `trigger-secret.db.test.ts`):
  share mint→rotate→disable lifecycle + token acceptance upserts exactly one
  collaborator row (idempotent re-open).
- Live verification on deploy: guest opens link signed-out → lands on flow
  after sign-in → jams (cursor/edit/huddle) → cannot run/publish; TURN env
  unset keeps huddle behavior identical to v1.
- Gates: typecheck, lint, full suite, ci_repro migrate-from-zero + DB suite +
  CI-mode build before push.

## Out of scope (v1.5)

- Collaborator management UI (list/remove/change role) and revoking accepted
  collaborators on rotate.
- Anonymous/public (unauthenticated) share links.
- Guest execution, publish, runs history, versions, Copilot.
- Ephemeral/short-lived TURN credentials (endpoint structure permits later).
- Same-field CRDT (text) merge.

## Build order

1. TURN (helper + endpoint + hook fetch).
2. Field-level merge (graph-ops + tests).
3. Share schema + `resolveFlowRole` + share/single-flow endpoints + list/PUT
   role-awareness.
4. Client: builder guest mode + dialog share section + load fallback.
5. Gates, ci_repro, push, live verification notes.
