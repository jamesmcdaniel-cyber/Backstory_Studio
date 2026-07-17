# Jam v1.5 — TURN, Field-Level Merge, Share Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close jam v1's three gaps: env-configured TURN relay for the huddle, per-field merge for same-node concurrent edits, and cross-workspace share links backed by a collaborator table (view/jam-edit only — no guest execution).

**Architecture:** TURN config flows through a new auth-gated ICE endpoint (env vars → `iceServersFromEnv` → `useFlowHuddle.join()` fetch, STUN fallback). Field merge extends the existing `graph-ops` diff/apply layer with `patchNodes` (shallow per-field diff of `node.data`). Sharing adds `FlowCollaborator` + `Flow.shareToken/shareRole`, a pure `resolveFlowRole`, a share-management route, a single-flow GET that performs token acceptance, and role-aware list/PUT — guests get the canvas and the jam, never run/publish.

**Tech Stack:** Next.js 15 route handlers, Prisma 6/Postgres, Supabase Realtime (unchanged), WebRTC, `node:test` + tsx, Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-07-16-jam-gaps-turn-fieldmerge-sharelinks-design.md`

## Global Constraints

- No raw `{{token}}` bracket syntax in any user-visible copy.
- Local dev has NO Supabase/DB env vars: gates are `npm run typecheck`, `npm run lint`, `npm test`; DB-backed tests run only under `TEST_DATABASE_URL` (ci_repro / CI). One-file run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`.
- Migrations are hand-written SQL in `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`; applied by `prisma migrate deploy` (never `migrate dev`/`db push` locally).
- Guests (cross-org viewers) must NEVER gain run/publish/runs/history/versions/Copilot/settings surface — server walls stay org-scoped AND the UI hides them.
- Guests must never receive `shareToken` in any payload.
- Same-org access semantics must remain byte-for-byte v1 (`shared`/`view`/`private`, legacy ownerless editable).
- Only ONE Supabase channel per flow; no realtime changes in this plan.
- Commit after every task; end commit messages with the repo's Claude co-author trailer.

---

### Task 1: TURN — `iceServersFromEnv` + `/api/flows/huddle-ice` + hook fetch

**Files:**
- Create: `src/lib/flows/ice-config.ts`
- Create: `src/lib/flows/__tests__/ice-config.test.ts`
- Create: `src/app/api/flows/huddle-ice/route.ts`
- Modify: `src/lib/flows/use-flow-huddle.ts` (join() fetches config; createPeer uses it)

**Interfaces:**
- Consumes: nothing new.
- Produces: `iceServersFromEnv(env: { TURN_URL?: string; TURN_USERNAME?: string; TURN_CREDENTIAL?: string }): { urls: string | string[]; username?: string; credential?: string }[]`; `GET /api/flows/huddle-ice` → `{ success: true, iceServers }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/ice-config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iceServersFromEnv } from '../ice-config'

test('STUN always present; TURN appended only with full config', () => {
  assert.deepEqual(iceServersFromEnv({}), [{ urls: 'stun:stun.l.google.com:19302' }])
  assert.deepEqual(
    iceServersFromEnv({ TURN_URL: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' }),
    [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' },
    ],
  )
})

test('partial TURN config stays STUN-only; comma list becomes an array', () => {
  assert.deepEqual(iceServersFromEnv({ TURN_URL: 'turn:x', TURN_USERNAME: 'u' }), [
    { urls: 'stun:stun.l.google.com:19302' },
  ])
  const out = iceServersFromEnv({ TURN_URL: 'turn:a, turns:b', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' })
  assert.deepEqual(out[1].urls, ['turn:a', 'turns:b'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/ice-config.test.ts`
Expected: FAIL — cannot find module `../ice-config`.

- [ ] **Step 3: Implement `src/lib/flows/ice-config.ts`**

```ts
export type IceServer = { urls: string | string[]; username?: string; credential?: string }

/**
 * WebRTC ICE servers from env. Always Google STUN; a TURN relay entry is
 * appended only when ALL of TURN_URL / TURN_USERNAME / TURN_CREDENTIAL are
 * set (a half-configured relay is worse than none). TURN_URL may be a
 * comma-separated list. Creds are read server-side only — the huddle-ice
 * endpoint hands them to authenticated users at call time, never the bundle.
 */
export function iceServersFromEnv(env: {
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
}): IceServer[] {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const urls = (env.TURN_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls: urls.length === 1 ? urls[0] : urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL })
  }
  return servers
}
```

- [ ] **Step 4: Run to verify pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/ice-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `src/app/api/flows/huddle-ice/route.ts`**

```ts
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { iceServersFromEnv } from '@/lib/flows/ice-config'

// GET /api/flows/huddle-ice — WebRTC ICE config for the voice huddle. TURN
// creds live in env (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL) and reach only
// authenticated users at call time — never the client bundle. STUN-only until
// the env vars are set; enabling a relay is a Vercel env change, no deploy.
export const GET = withAuthenticatedApi(async () => ({
  success: true,
  iceServers: iceServersFromEnv(process.env),
}))
```

- [ ] **Step 6: Fetch the config in `useFlowHuddle.join()`**

In `src/lib/flows/use-flow-huddle.ts`:

1. Below `const joinedRef = useRef(false)` add:

```ts
  // ICE config from the auth-gated endpoint (env-driven TURN); fetched once
  // per mount on first join. Any failure falls back to baked-in STUN.
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
```

2. In `createPeer`, replace `const pc = new RTCPeerConnection(RTC_CONFIG)` with:

```ts
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current ?? RTC_CONFIG.iceServers })
```

3. In `join()`, immediately after `setConnecting(true)` / inside the `try`, BEFORE `getUserMedia`, add:

```ts
      if (!iceServersRef.current) {
        try {
          const res = await fetch('/api/flows/huddle-ice', { cache: 'no-store' })
          const data = await res.json().catch(() => null)
          if (res.ok && Array.isArray(data?.iceServers) && data.iceServers.length) iceServersRef.current = data.iceServers
        } catch { /* STUN fallback via createPeer */ }
        iceServersRef.current ??= (RTC_CONFIG.iceServers as RTCIceServer[] | undefined) ?? null
      }
```

- [ ] **Step 7: Gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 0 errors; only the 8 pre-existing lint warnings; all tests pass (2 new).

- [ ] **Step 8: Commit**

```bash
git add src/lib/flows/ice-config.ts src/lib/flows/__tests__/ice-config.test.ts src/app/api/flows/huddle-ice/route.ts src/lib/flows/use-flow-huddle.ts
git commit -m "feat(flows): env-configured TURN via auth-gated huddle-ice endpoint, STUN fallback"
```

---

### Task 2: Field-level merge in graph-ops

**Files:**
- Modify: `src/lib/flows/graph-ops.ts`
- Create: `src/lib/flows/__tests__/graph-ops-patch.test.ts`

**Interfaces:**
- Consumes: existing `diffGraph`/`applyGraphOps`/`isEmptyOps` (signatures unchanged).
- Produces: `GraphOps` gains `patchNodes?: NodePatch[]` where `type NodePatch = { id: string; set?: Record<string, unknown>; unset?: string[] }`. Broadcast/merge callers (`use-flow-collab.ts`) need NO changes — ops stay opaque to them.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/flows/__tests__/graph-ops-patch.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffGraph, applyGraphOps, isEmptyOps } from '../graph-ops'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const node = (id: string, data: Record<string, unknown>, type = 'agent'): FlowNode =>
  ({ id, type, data } as unknown as FlowNode)
const g = (...nodes: FlowNode[]): FlowGraph => ({ nodes, edges: [] })

test('a data-field change emits a patch, not a full upsert', () => {
  const prev = g(node('a', { agentId: '1', label: 'Old' }))
  const next = g(node('a', { agentId: '1', label: 'New' }))
  const ops = diffGraph(prev, next)
  assert.equal(ops.upsertNodes, undefined)
  assert.deepEqual(ops.patchNodes, [{ id: 'a', set: { label: 'New' } }])
  assert.equal(isEmptyOps(ops), false)
})

test('round-trip: applying the diff reproduces the target graph', () => {
  const prev = g(node('a', { agentId: '1', label: 'Old', note: 'gone' }))
  const next = g(node('a', { agentId: '2', label: 'Old' }))
  assert.deepEqual(applyGraphOps(prev, diffGraph(prev, next)), next)
})

test('concurrent edits to DIFFERENT fields of the same node both survive', () => {
  const base = g(node('a', { agentId: '1', label: 'A' }))
  const opsLabel = diffGraph(base, g(node('a', { agentId: '1', label: 'B' })))
  const opsAgent = diffGraph(base, g(node('a', { agentId: '2', label: 'A' })))
  const merged = applyGraphOps(applyGraphOps(base, opsLabel), opsAgent)
  assert.deepEqual(merged.nodes[0], node('a', { agentId: '2', label: 'B' }))
})

test('a removed data key travels as unset and is deleted on apply', () => {
  const prev = g(node('a', { agentId: '1', note: 'temp' }))
  const next = g(node('a', { agentId: '1' }))
  const ops = diffGraph(prev, next)
  assert.deepEqual(ops.patchNodes, [{ id: 'a', unset: ['note'] }])
  assert.deepEqual(applyGraphOps(prev, ops), next)
})

test('a type change falls back to a full upsert', () => {
  const prev = g(node('a', { agentId: '1' }, 'agent'))
  const next = g(node('a', { url: 'https://x', method: 'GET' }, 'http'))
  const ops = diffGraph(prev, next)
  assert.equal(ops.patchNodes, undefined)
  assert.equal(ops.upsertNodes?.length, 1)
})

test('a patch for a locally-deleted node is a no-op (delete wins)', () => {
  const base = g(node('a', { agentId: '1', label: 'A' }), node('b', { agentId: '2' }))
  const patchA = diffGraph(base, g(node('a', { agentId: '1', label: 'B' }), node('b', { agentId: '2' })))
  const localWithoutA = g(node('b', { agentId: '2' }))
  const merged = applyGraphOps(localWithoutA, patchA)
  assert.deepEqual(merged.nodes.map((n) => n.id), ['b'], 'patch must not resurrect a deleted node')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-ops-patch.test.ts`
Expected: FAIL (patchNodes undefined everywhere; first test's `deepEqual` fails).

- [ ] **Step 3: Extend `src/lib/flows/graph-ops.ts`**

1. Add after the `GraphOps` type's opening doc (extend the type):

```ts
/** Per-field patch of one node's `data` — the field-level merge unit. Two
 *  people editing DIFFERENT fields of the SAME node no longer clobber each
 *  other; only the same field stays last-write-wins. */
export type NodePatch = { id: string; set?: Record<string, unknown>; unset?: string[] }
```

and add to `GraphOps`:

```ts
  patchNodes?: NodePatch[]
```

2. Replace the node-diff section of `diffGraph` (the two lines computing `upsertNodes`/`removeNodeIds` stay for edges; nodes become):

```ts
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodeIds = new Set(next.nodes.map((n) => n.id))
  const upsertNodes: FlowNode[] = []
  const patchNodes: NodePatch[] = []
  for (const n of next.nodes) {
    const before = prevNodes.get(n.id)
    if (!before) { upsertNodes.push(n); continue }        // new node
    if (same(before, n)) continue                          // unchanged
    if (before.type !== n.type) { upsertNodes.push(n); continue } // retype = atomic
    // Same node, same type: diff data at field granularity.
    const prevData = before.data as Record<string, unknown>
    const nextData = n.data as Record<string, unknown>
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    for (const key of Object.keys(nextData)) if (!same(prevData[key], nextData[key])) set[key] = nextData[key]
    for (const key of Object.keys(prevData)) if (!(key in nextData)) unset.push(key)
    if (Object.keys(set).length || unset.length) {
      patchNodes.push({ id: n.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) })
    } else {
      upsertNodes.push(n) // changed outside data (defensive) — send whole node
    }
  }
  const removeNodeIds = prev.nodes.filter((n) => !nextNodeIds.has(n.id)).map((n) => n.id)
```

and in the ops assembly add:

```ts
  if (patchNodes.length) ops.patchNodes = patchNodes
```

3. In `isEmptyOps` add the clause:

```ts
  return (
    !ops.upsertNodes?.length && !ops.removeNodeIds?.length && !ops.patchNodes?.length &&
    !ops.upsertEdges?.length && !ops.removeEdgeIds?.length
  )
```

4. In `applyGraphOps`, extend the node loop:

```ts
  const upsertNode = new Map((ops.upsertNodes ?? []).map((n) => [n.id, n]))
  const patchNode = new Map((ops.patchNodes ?? []).map((p) => [p.id, p]))
  const removeNode = new Set(ops.removeNodeIds ?? [])
  const nodes: FlowNode[] = []
  const seenNode = new Set<string>()
  for (const n of graph.nodes) {
    if (removeNode.has(n.id)) continue
    seenNode.add(n.id)
    const upserted = upsertNode.get(n.id)
    if (upserted) { nodes.push(upserted); continue }
    const patch = patchNode.get(n.id)
    if (patch) {
      // Field-level merge: our other fields survive a teammate's edit.
      const data = { ...(n.data as Record<string, unknown>), ...(patch.set ?? {}) }
      for (const key of patch.unset ?? []) delete data[key]
      nodes.push({ ...n, data } as FlowNode)
      continue
    }
    nodes.push(n)
  }
  for (const n of ops.upsertNodes ?? []) if (!seenNode.has(n.id) && !removeNode.has(n.id)) nodes.push(n)
  // NOTE: patches for nodes absent locally are deliberately dropped — a
  // concurrent delete wins over a field edit.
```

(Edge handling stays exactly as-is. Update the `applyGraphOps` doc comment's first line to mention patches merge per-field.)

- [ ] **Step 4: Run to verify pass (new + existing)**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/graph-ops-patch.test.ts src/lib/flows/__tests__/graph-ops.test.ts src/lib/flows/__tests__/use-flow-collab.test.ts`
Expected: PASS — 6 new tests plus all existing graph-ops/collab tests unchanged.

- [ ] **Step 5: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (baseline warnings only).

```bash
git add src/lib/flows/graph-ops.ts src/lib/flows/__tests__/graph-ops-patch.test.ts
git commit -m "feat(flows): field-level merge — same-node concurrent edits patch per data field"
```

---

### Task 3: Share data model + `resolveFlowRole` + role-aware serialization

**Files:**
- Create: `prisma/migrations/20260716200000_flow_share_links/migration.sql`
- Create: `src/lib/flows/__tests__/access-roles.test.ts`
- Modify: `prisma/schema.prisma` (Flow model + new FlowCollaborator model)
- Modify: `src/lib/flows/access.ts` (add `resolveFlowRole`; keep existing exports untouched)
- Modify: `src/lib/flows/serialize.ts` (optional `access` param + share fields)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 4-5):
  - `resolveFlowRole(flow: FlowRoleInput, viewer: { userId: string; organizationId: string }, shareToken?: string | null): 'edit' | 'view' | null` with `type FlowRoleInput = { organizationId: string; visibility: string; userId: string | null; shareToken?: string | null; shareRole?: string | null; collaboratorRole?: string | null }`
  - `serializeFlow(flow, viewerId?, access?: FlowViewerAccess)` with `type FlowViewerAccess = { role: 'edit' | 'view'; external: boolean; includeShare?: boolean }` — when `access` is given: `canEdit = role === 'edit'`, plus `role`, `external`, and (only when `includeShare`) `shareToken`/`shareRole` in the payload.
  - Prisma: `FlowCollaborator` model (`flowId_userId` compound unique), `Flow.shareToken String? @unique`, `Flow.shareRole String @default("view")`.

- [ ] **Step 1: Write the failing role-matrix test**

Create `src/lib/flows/__tests__/access-roles.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlowRole, type FlowRoleInput } from '../access'

const owner = { userId: 'u-owner', organizationId: 'org-a' }
const teammate = { userId: 'u-team', organizationId: 'org-a' }
const outsider = { userId: 'u-out', organizationId: 'org-b' }
const flow = (over: Partial<FlowRoleInput> = {}): FlowRoleInput => ({
  organizationId: 'org-a', visibility: 'shared', userId: 'u-owner',
  shareToken: null, shareRole: 'view', collaboratorRole: null, ...over,
})

test('same-org semantics match v1 exactly', () => {
  assert.equal(resolveFlowRole(flow(), teammate), 'edit')                                     // shared → org edits
  assert.equal(resolveFlowRole(flow({ visibility: 'view' }), teammate), 'view')               // view → org views
  assert.equal(resolveFlowRole(flow({ visibility: 'view' }), owner), 'edit')                  // owner edits
  assert.equal(resolveFlowRole(flow({ visibility: 'view', userId: null }), teammate), 'edit') // legacy ownerless
  assert.equal(resolveFlowRole(flow({ visibility: 'private' }), teammate), null)              // private hidden
  assert.equal(resolveFlowRole(flow({ visibility: 'private' }), owner), 'edit')               // owner sees own
})

test('cross-org: collaborator row wins; a valid token grants shareRole; else invisible', () => {
  assert.equal(resolveFlowRole(flow(), outsider), null)
  assert.equal(resolveFlowRole(flow({ collaboratorRole: 'view' }), outsider), 'view')
  assert.equal(resolveFlowRole(flow({ collaboratorRole: 'edit' }), outsider), 'edit')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok', shareRole: 'edit' }), outsider, 'tok'), 'edit')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok', shareRole: 'view' }), outsider, 'tok'), 'view')
  assert.equal(resolveFlowRole(flow({ shareToken: 'tok' }), outsider, 'nope'), null)
  assert.equal(resolveFlowRole(flow({ shareToken: null }), outsider, 'tok'), null)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/access-roles.test.ts`
Expected: FAIL — `resolveFlowRole` is not exported.

- [ ] **Step 3: Add `resolveFlowRole` to `src/lib/flows/access.ts`** (append; existing `canEditFlow`/`assertFlowEditable` untouched)

```ts
export type FlowRoleInput = {
  organizationId: string
  visibility: string
  userId: string | null
  shareToken?: string | null
  shareRole?: string | null
  collaboratorRole?: string | null
}

/**
 * The viewer's role on a flow, across workspace boundaries:
 *  1. Owner → edit, always.
 *  2. Same org → v1 semantics verbatim (shared=edit, view=view [legacy
 *     ownerless stays editable], private=owner-only).
 *  3. Cross-org: an accepted collaborator row's role wins; else a presented
 *     share token that matches grants the flow's shareRole.
 *  4. Otherwise null — the flow does not exist for this viewer.
 */
export function resolveFlowRole(
  flow: FlowRoleInput,
  viewer: { userId: string; organizationId: string },
  shareToken?: string | null,
): 'edit' | 'view' | null {
  if (flow.userId && flow.userId === viewer.userId) return 'edit'
  if (flow.organizationId === viewer.organizationId) {
    if (flow.visibility === 'private') return null
    if (flow.visibility === 'view') return flow.userId ? 'view' : 'edit'
    return 'edit'
  }
  if (flow.collaboratorRole === 'edit' || flow.collaboratorRole === 'view') return flow.collaboratorRole
  if (shareToken && flow.shareToken && shareToken === flow.shareToken) return flow.shareRole === 'edit' ? 'edit' : 'view'
  return null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/access-roles.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Schema + migration**

In `prisma/schema.prisma`, inside `model Flow` add after `visibility     String   @default("shared")`:

```prisma
  shareToken     String?  @unique
  shareRole      String   @default("view") // role a share-link grants: 'view' | 'edit'
```

and add to Flow's relation block (next to `runs`/`versions`):

```prisma
  collaborators FlowCollaborator[]
```

After the Flow model add:

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

Create `prisma/migrations/20260716200000_flow_share_links/migration.sql`:

```sql
-- Cross-workspace jam: durable per-user grants (collaborators) + rotatable
-- tokenized share links. Rotation revokes future opens; accepted rows persist.
CREATE TABLE "public"."flow_collaborators" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'edit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "flow_collaborators_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "flow_collaborators_flowId_userId_key" ON "public"."flow_collaborators"("flowId", "userId");
CREATE INDEX "flow_collaborators_userId_idx" ON "public"."flow_collaborators"("userId");
ALTER TABLE "public"."flow_collaborators"
  ADD CONSTRAINT "flow_collaborators_flowId_fkey" FOREIGN KEY ("flowId")
  REFERENCES "public"."flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."flows" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "public"."flows" ADD COLUMN "shareRole" TEXT NOT NULL DEFAULT 'view';
CREATE UNIQUE INDEX "flows_shareToken_key" ON "public"."flows"("shareToken");
```

- [ ] **Step 6: Role-aware `serializeFlow`**

In `src/lib/flows/serialize.ts`:

1. Add to the `flow` param type: `shareToken?: string | null` and `shareRole?: string`.
2. Add above the function:

```ts
export type FlowViewerAccess = { role: 'edit' | 'view'; external: boolean; includeShare?: boolean }
```

3. Change the signature to `(flow, viewerId?: string, access?: FlowViewerAccess)` and inside the returned object:
   - replace the `canEdit` line with:

```ts
    // Whether THIS viewer may edit. Role-aware callers (share/single-flow/list
    // routes) pass `access`; legacy org-only callers keep the v1 derivation.
    canEdit: access
      ? access.role === 'edit'
      : viewerId === undefined
        ? true
        : canEditFlow({ visibility: flow.visibility, userId: flow.userId ?? null }, viewerId),
```

   - add after the `ownerId` line:

```ts
    ...(access && {
      role: access.role,
      // Cross-workspace guest: UI hides run/publish/settings; PUT enforces graph-only.
      external: access.external,
      ...(access.includeShare
        ? { shareToken: flow.shareToken ?? null, shareRole: flow.shareRole === 'edit' ? 'edit' : 'view' }
        : {}),
    }),
```

- [ ] **Step 7: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean — no call site breaks (both new params are optional).

```bash
git add prisma/schema.prisma prisma/migrations/20260716200000_flow_share_links src/lib/flows/access.ts src/lib/flows/serialize.ts src/lib/flows/__tests__/access-roles.test.ts
git commit -m "feat(flows): collaborator table + share token schema, resolveFlowRole, role-aware serialization"
```

---

### Task 4: Share endpoints + role-aware list/PUT + DB test

**Files:**
- Create: `src/app/api/flows/[id]/share/route.ts`
- Create: `src/app/api/flows/[id]/route.ts`
- Create: `src/app/api/flows/__tests__/share.db.test.ts`
- Modify: `src/app/api/flows/route.ts` (GET list + PUT)

**Interfaces:**
- Consumes: `resolveFlowRole`, `FlowViewerAccess`-shaped `access` param of `serializeFlow` (Task 3).
- Produces:
  - `POST /api/flows/[id]/share` body `{ enabled: boolean, role: 'view'|'edit', rotate?: boolean }` → `{ success, shareToken: string | null, shareRole: 'view'|'edit' }`. Same-org editors only. `enabled` with an existing token KEEPS it unless `rotate: true`; `enabled: false` clears it.
  - `GET /api/flows/[id]?share=<token>` → `{ success, flow }` (role-aware serialization; token acceptance upserts the collaborator row for cross-org viewers).
  - `GET /api/flows` list now includes collaborated flows with `role`/`external` fields.
  - `PUT /api/flows` role-aware; cross-org editors limited to `{ id, graph, baseUpdatedAt, suppressAudit }` → else 403 `GUEST_GRAPH_ONLY`.

- [ ] **Step 1: Create `src/app/api/flows/[id]/share/route.ts`**

```ts
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { recordAudit } from '@/lib/audit'

const bodySchema = z.object({
  enabled: z.boolean(),
  role: z.enum(['view', 'edit']).default('view'),
  rotate: z.boolean().optional(),
})

// POST /api/flows/[id]/share — manage the cross-workspace share link. Only a
// same-org EDITOR may manage sharing (the org-scoped lookup below is that
// wall — guests can never reach this). Enabling mints a token when none
// exists and otherwise keeps it (so changing the role doesn't break sent
// links); `rotate: true` forces a fresh token (old links stop working);
// disabling clears it. Rotation does NOT remove already-accepted
// collaborators — their rows are durable grants.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, visibility: true, userId: true, shareToken: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)
  const { enabled, role, rotate } = bodySchema.parse(await request.json())
  const shareToken = !enabled ? null : rotate || !flow.shareToken ? randomBytes(16).toString('hex') : flow.shareToken
  const updated = await prisma.flow.update({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { shareToken, shareRole: role },
  })
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: enabled ? 'flow.share_link_enabled' : 'flow.share_link_disabled',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { role, rotated: Boolean(rotate) },
  }).catch(() => undefined)
  return { success: true, shareToken: updated.shareToken, shareRole: updated.shareRole === 'edit' ? 'edit' : 'view' }
})
```

- [ ] **Step 2: Create `src/app/api/flows/[id]/route.ts`**

```ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveFlowRole } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { recordAudit } from '@/lib/audit'

// GET /api/flows/[id]?share=<token> — single-flow fetch that resolves access
// beyond the caller's org: same-org visibility, an accepted collaborator row,
// or a valid share token. A token's first cross-org open UPSERTS the
// collaborator row — that IS invite acceptance; later opens need no token.
// Everyone else gets a 404 indistinguishable from a missing flow.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Flow id is required')
  const token = request.nextUrl.searchParams.get('share')
  const flow = await prisma.flow.findUnique({
    where: { id },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const viewer = { userId: auth.dbUser.id, organizationId: auth.organizationId }
  const role = resolveFlowRole({ ...flow, collaboratorRole: flow.collaborators[0]?.role ?? null }, viewer, token)
  if (!role) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const external = flow.organizationId !== auth.organizationId
  if (external && !flow.collaborators.length && token && token === flow.shareToken) {
    // Acceptance: the durable grant. Idempotent — re-opens never duplicate.
    await prisma.flowCollaborator.upsert({
      where: { flowId_userId: { flowId: flow.id, userId: auth.dbUser.id } },
      create: { flowId: flow.id, userId: auth.dbUser.id, role },
      update: {},
    })
    void recordAudit({
      organizationId: flow.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'flow.share_accepted',
      resourceType: 'flow',
      resourceId: flow.id,
      detail: { role },
    }).catch(() => undefined)
  }
  return {
    success: true,
    flow: serializeFlow(flow, auth.dbUser.id, { role, external, includeShare: !external && role === 'edit' }),
  }
})
```

- [ ] **Step 3: Role-aware GET list + PUT in `src/app/api/flows/route.ts`**

1. Add to imports: `resolveFlowRole` from `@/lib/flows/access` (alongside `assertFlowEditable`).

2. Replace the `GET` handler with:

```ts
export const GET = withAuthenticatedApi(async (_request, auth) => {
  // Org flows (v1 visibility rules) PLUS flows shared with this user across
  // workspaces (accepted collaborator rows).
  const flows = await prisma.flow.findMany({
    where: {
      OR: [
        { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
        { collaborators: { some: { userId: auth.dbUser.id } } },
      ],
    },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  const viewer = { userId: auth.dbUser.id, organizationId: auth.organizationId }
  return {
    success: true,
    flows: flows.map((flow) => {
      const role = resolveFlowRole({ ...flow, collaboratorRole: flow.collaborators[0]?.role ?? null }, viewer)
      const external = flow.organizationId !== auth.organizationId
      return serializeFlow(flow, auth.dbUser.id, role ? { role, external, includeShare: !external && role === 'edit' } : undefined)
    }),
  }
})
```

3. In the `PUT` handler, replace the lookup + editability block (from `const existing = await prisma.flow.findFirst...` through `assertFlowEditable(existing, auth.dbUser.id)`) with:

```ts
  const existing = await prisma.flow.findUnique({
    where: { id: body.id },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const role = resolveFlowRole(
    { ...existing, collaboratorRole: existing.collaborators[0]?.role ?? null },
    { userId: auth.dbUser.id, organizationId: auth.organizationId },
  )
  if (!role) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  if (role !== 'edit') throw new ApiError('This flow is view-only for you — ask its owner for edit access.', 403, 'FLOW_VIEW_ONLY')
  // Guests (cross-workspace collaborators) may write the CANVAS only — name,
  // sharing, and settings stay with the owning workspace.
  if (existing.organizationId !== auth.organizationId) {
    const allowed = new Set(['id', 'graph', 'baseUpdatedAt', 'suppressAudit'])
    const blocked = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined && !allowed.has(key))
    if (blocked.length) {
      throw new ApiError('Guests can edit the canvas only — name, sharing, and settings stay with the owning workspace.', 403, 'GUEST_GRAPH_ONLY')
    }
  }
```

4. In the same PUT: change the `prisma.flow.update` `where` from `{ id: body.id, organizationId: auth.organizationId }` to `{ id: body.id }` (access is resolved above; a guest update must not 404 on the org filter), and in the `recordAudit` call change `organizationId: auth.organizationId` to `organizationId: existing.organizationId` (edits audit into the OWNING org's timeline, including guest edits).

(DELETE stays org-scoped and unchanged — guests cannot delete.)

- [ ] **Step 4: Write the DB-backed lifecycle test**

Create `src/app/api/flows/__tests__/share.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let shareRoute: any
  let flowRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    shareRoute = await import('../[id]/share/route')
    flowRoute = await import('../[id]/route')
  })

  const share = (flowId: string, body: Record<string, unknown>) =>
    shareRoute.POST(new NextRequest(new URL(`http://test/api/flows/${flowId}/share`), { method: 'POST', body: JSON.stringify(body) }))
  const open = (flowId: string, token?: string | null) =>
    flowRoute.GET(new NextRequest(new URL(`http://test/api/flows/${flowId}${token ? `?share=${token}` : ''}`)))
  const mkFlow = (organizationId: string, userId: string) =>
    prisma.flow.create({ data: { organizationId, userId, name: 'Shared flow', graph: { nodes: [], edges: [] } } })

  test('share lifecycle: mint → role change keeps token → rotate mints fresh → disable clears', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const minted = await (await share(flow.id, { enabled: true, role: 'edit' })).json()
      assert.ok(minted.shareToken, 'mint returns a token')
      assert.equal(minted.shareRole, 'edit')
      const roleChanged = await (await share(flow.id, { enabled: true, role: 'view' })).json()
      assert.equal(roleChanged.shareToken, minted.shareToken, 'role change keeps the token — sent links stay valid')
      assert.equal(roleChanged.shareRole, 'view')
      const rotated = await (await share(flow.id, { enabled: true, role: 'view', rotate: true })).json()
      assert.ok(rotated.shareToken && rotated.shareToken !== minted.shareToken, 'rotate mints a fresh token')
      const disabled = await (await share(flow.id, { enabled: false, role: 'view' })).json()
      assert.equal(disabled.shareToken, null)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('token acceptance upserts exactly one collaborator row (idempotent) and grants durable access; guests never see the token', async () => {
    const ownerOrg = await seedTestOrg(prisma)
    const guestOrg = await seedTestOrg(prisma)
    try {
      installTestAuth(ownerOrg.auth)
      const flow = await mkFlow(ownerOrg.organizationId, ownerOrg.userId)
      const { shareToken } = await (await share(flow.id, { enabled: true, role: 'edit' })).json()
      installTestAuth(guestOrg.auth)
      assert.equal((await open(flow.id)).status, 404, 'no token, no row → invisible')
      assert.equal((await open(flow.id, 'wrong-token')).status, 404, 'bad token → invisible')
      const first = await open(flow.id, shareToken)
      assert.equal(first.status, 200)
      const body = await first.json()
      assert.equal(body.flow.role, 'edit')
      assert.equal(body.flow.external, true)
      assert.ok(!('shareToken' in body.flow), 'guests never receive the token')
      await open(flow.id, shareToken) // idempotent re-open
      const rows = await prisma.flowCollaborator.findMany({ where: { flowId: flow.id, userId: guestOrg.userId } })
      assert.equal(rows.length, 1, 'exactly one collaborator row')
      assert.equal((await open(flow.id)).status, 200, 'the row grants access without the token')
    } finally {
      await ownerOrg.cleanup(); await guestOrg.cleanup()
      await prisma.organization.delete({ where: { id: ownerOrg.organizationId } }).catch(() => {})
      await prisma.organization.delete({ where: { id: guestOrg.organizationId } }).catch(() => {})
    }
  })
}
```

- [ ] **Step 5: Local gates (DB test is a no-op locally), then ci_repro run**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (share.db.test.ts skips without TEST_DATABASE_URL).

Then apply the new migration to a fresh ci_repro and run the DB suite:

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ci_repro' -c 'CREATE DATABASE ci_repro'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm test
```

Expected: migrate deploy applies `20260716200000_flow_share_links`; full suite passes including the 2 new DB tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/flows/[id]/share src/app/api/flows/[id]/route.ts src/app/api/flows/route.ts src/app/api/flows/__tests__/share.db.test.ts
git commit -m "feat(flows): share-link endpoints, token acceptance, role-aware list/PUT with guest graph-only wall"
```

---

### Task 5: Client — guest mode, share-link load fallback, dialog share section

**Files:**
- Modify: `src/app/flows/[id]/page.tsx` (state, load fallback, toolbar gating, banner, dialog props)
- Modify: `src/components/flows/jam-dialog.tsx` (share section + tokenized invite link)

**Interfaces:**
- Consumes: `GET /api/flows/[id]?share=` + `POST /api/flows/[id]/share` (Task 4); serialized `role`/`external`/`shareToken`/`shareRole` fields (Task 3).
- Produces: `JamDialog` new props — `shareToken?: string | null; shareRole?: 'view' | 'edit'; onShareChanged?: (token: string | null, role: 'view' | 'edit') => void`.

- [ ] **Step 1: Page state + share-aware load**

In `src/app/flows/[id]/page.tsx`:

1. Add state next to `const [ownerId, setOwnerId] = useState<string | null>(null)`:

```ts
  // Cross-workspace guest? (UI hides run/publish/settings; server enforces.)
  const [external, setExternal] = useState(false)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [shareRole, setShareRole] = useState<'view' | 'edit'>('view')
```

2. In the initial-load effect, make the `.then` callback async and add the fallback. Replace:

```ts
      .then(([flowsData, agentsData]) => {
        if (cancelled) return
        const flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
```

with:

```ts
      .then(async ([flowsData, agentsData]) => {
        if (cancelled) return
        let flow = (flowsData.flows || []).find((f: { id: string }) => f.id === id)
        if (!flow) {
          // Not in our list: a share-link open (token in URL) or a flow we can
          // access but haven't accepted yet — the single-flow endpoint
          // resolves both and performs token acceptance.
          const shareParam = searchParams.get('share')
          const res = await fetch(`/api/flows/${id}${shareParam ? `?share=${encodeURIComponent(shareParam)}` : ''}`, { cache: 'no-store' }).catch(() => null)
          const data = res && res.ok ? await res.json().catch(() => null) : null
          if (data?.flow) flow = data.flow
        }
        if (cancelled) return
```

3. In the `if (flow) { ... }` block, after `setOwnerId(flow.ownerId ?? null)`, add:

```ts
          setExternal(Boolean(flow.external))
          setShareToken(flow.shareToken ?? null)
          setShareRole(flow.shareRole === 'edit' ? 'edit' : 'view')
```

4. Add `searchParams` to that effect's dependency array: `[id, searchParams]`.

5. Add a defensive guard at the top of `save()` (first line of the callback):

```ts
    if (external) return false // guests autosave the canvas; settings saves are org-only
```

and add `external` to `save`'s dependency array.

- [ ] **Step 2: Guest banner + toolbar gating**

1. Replace the view-only banner block:

```tsx
      {!canEdit && (
```

with:

```tsx
      {external && (
        <div className="flex items-center justify-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs font-medium text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          Guest access — you’re jamming on another workspace’s flow. Running and publishing stay with the owning workspace.
        </div>
      )}
      {!canEdit && !external && (
```

2. In the toolbar, wrap each of these buttons in `{!external && ( ... )}`: **Test**, **Runs**, the **Activity** ghost button, **History**, **Copilot**, **Save**, **Publish**, the published-only **Revert**, and **Run**. (Keep: Undo/Redo, export dropdown, presence stack, Jam, Checker.)

3. In the export dropdown: change the Sharing block gate from `{canEdit && (` to `{canEdit && !external && (`, and wrap the delete section (the `DropdownMenuSeparator` + "Delete flow" `DropdownMenuItem`) in `{!external && ( <> ... </> )}`.

- [ ] **Step 3: Dialog props from the page**

Update the `<JamDialog … />` render:

```tsx
      <JamDialog
        open={showJam}
        onOpenChange={setShowJam}
        flowId={id}
        flowName={name}
        visibility={visibility as 'shared' | 'view' | 'private'}
        canEdit={canEdit && !external}
        onChangeVisibility={(next) => void updateSharing(next)}
        presence={others.map((p) => ({ id: p.clientId, name: p.name, color: p.color, inHuddle: p.inHuddle }))}
        onJoinHuddle={() => { setShowJam(false); void huddle.join() }}
        huddleJoined={huddle.joined}
        shareToken={shareToken}
        shareRole={shareRole}
        onShareChanged={(token, role) => { setShareToken(token); setShareRole(role) }}
      />
```

- [ ] **Step 4: Dialog share section**

In `src/components/flows/jam-dialog.tsx`:

1. Add `RefreshCw` to the lucide import and add `import { Switch } from '@/components/ui/switch'`.

2. Add props (after `huddleJoined?: boolean` in both destructuring and type):

```ts
  /** Cross-workspace share link state (same-org editors only). */
  shareToken?: string | null
  shareRole?: 'view' | 'edit'
  onShareChanged?: (token: string | null, role: 'view' | 'edit') => void
```

3. Make the invite link token-aware — replace the `inviteLink` line with:

```ts
  const inviteLink = typeof window !== 'undefined'
    ? `${window.location.origin}/flows/${flowId}${shareToken ? `?share=${shareToken}` : ''}`
    : `/flows/${flowId}`
```

4. Add the share mutation next to `sendInvites`:

```ts
  const [shareBusy, setShareBusy] = useState(false)
  const updateShare = async (enabled: boolean, role: 'view' | 'edit', rotate = false) => {
    setShareBusy(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, role, rotate }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not update the share link.')
        return
      }
      onShareChanged?.(data.shareToken ?? null, data.shareRole === 'edit' ? 'edit' : 'view')
      toast.success(!enabled
        ? 'Share link turned off.'
        : rotate
          ? 'Link rotated — old links no longer work.'
          : 'Share link ready — anyone with it can open this flow after signing in.')
    } finally {
      setShareBusy(false)
    }
  }
```

5. Render the section after the invite-teammates block (and after the private-flow notice), before "Who can access" — only for editors:

```tsx
          {canEdit && shareable && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Anyone with the link</p>
                <Switch
                  checked={Boolean(shareToken)}
                  disabled={shareBusy}
                  onCheckedChange={(on) => void updateShare(on, shareRole ?? 'view')}
                  aria-label="Share with people outside your workspace"
                />
              </div>
              {shareToken ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    {(['view', 'edit'] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        disabled={shareBusy}
                        onClick={() => void updateShare(true, r)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                          (shareRole ?? 'view') === r
                            ? 'border-indigo-300 bg-indigo-50/60 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200'
                            : 'border-border/70 text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {r === 'view' ? 'Can view' : 'Can edit'}
                      </button>
                    ))}
                    <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" disabled={shareBusy} onClick={() => void updateShare(true, shareRole ?? 'view', true)}>
                      <RefreshCw className="mr-1 h-3 w-3" /> Rotate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    People outside your workspace can open this flow with the link above after signing in.
                    Rotating makes old links stop working; people who already accepted keep access.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Off — only your workspace can open this flow.</p>
              )}
            </div>
          )}
```

- [ ] **Step 5: Gates + commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (baseline warnings only).

```bash
git add "src/app/flows/[id]/page.tsx" src/components/flows/jam-dialog.tsx
git commit -m "feat(flows): guest mode + share-link UI — tokenized invites, role picker, rotate, guest gating"
```

---

### Task 6: Full gates, CI-mode, push, ledger

**Files:** `.superpowers/sdd/progress.md` (local ledger; gitignored).

- [ ] **Step 1: Full local gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 0 errors; only the 8 pre-existing warnings.

- [ ] **Step 2: ci_repro from zero + DB suite + CI-mode build** (same env recipe as Task 4 Step 5, plus):

```bash
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm run build
```

Expected: migrate-from-zero clean, full DB suite green, build succeeds.

- [ ] **Step 3: Push + ledger**

```bash
git push origin main
```

Append a dated summary block to `.superpowers/sdd/progress.md` covering: TURN endpoint (env vars to set for relay: `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`), field-merge semantics, share-link/collaborator model + guest walls, and the live-verification checklist below.

- [ ] **Step 4: Live verification notes (two browsers, two DIFFERENT workspaces)**

1. Owner enables "Anyone with the link" (edit) → copies tokenized link.
2. Guest (other workspace) opens it signed-out → signs in → lands on the flow; guest banner shows; Run/Publish/Runs/History/Copilot/Save absent.
3. Guest jams: cursor, editing ring, live edits, huddle join — all work; guest edits persist via autosave.
4. Guest re-opens WITHOUT the token → still has access (collaborator row).
5. Owner rotates → the OLD tokenized link (in a third fresh session) 404s; the accepted guest keeps access.
6. Same-node concurrent edit: owner edits a step's label while guest edits the same step's instructions → both survive.
7. Huddle with TURN env unset behaves exactly as v1 (STUN); after setting the three env vars in Vercel, `GET /api/flows/huddle-ice` returns the relay entry.
