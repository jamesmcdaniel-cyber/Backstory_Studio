# Remediation WS-R6: Route Smoke Harness (incident regression net) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DB-backed smoke suite that invokes real authenticated API route handlers and fails on any HTTP 500 — the net that would have caught today's tenant-guard incident (untested routes throwing on unscoped queries), and a reusable harness for driving routes in tests.

**Architecture:** The blocker to testing routes today is that `requireAuthContext` calls Supabase, which no test can satisfy. We add a **production-inert** injectable auth override to `src/lib/server/auth.ts` — the same seam pattern already blessed in `src/lib/observability/sentry.ts` (`setErrorReporter`). It is consulted only when `NODE_ENV !== 'production'` AND `TEST_DATABASE_URL` is set (the exact gate every existing DB test already trusts; production sets neither), and defaults to null so real auth runs unless a test explicitly injects. A test helper seeds an org+user and installs that override; the smoke suite then imports each `withAuthenticatedApi`-wrapped handler, calls it with a constructed `NextRequest`, and asserts the response status is < 500. Routes returning 200/400/401/403/404 all pass — only a 5xx (a thrown, uncaught failure like a guard trip) fails.

**Tech Stack:** node:test (`tsx --test`), `NextRequest`/`NextResponse` from `next/server`, real Prisma against `TEST_DATABASE_URL`, the existing DB-test gating idiom.

**Scope Note — the flow-editor reducer is deferred to Phase 2 (separate plan).** The original WS-R6 line item bundled "Playwright smoke suite + flow-editor reducer." After scouting: (1) full Playwright *browser* E2E is disproportionate — CI never boots the app and has only a placeholder Supabase, so browser auth can't complete; the route-handler smoke suite delivers the incident-preventing value at a fraction of the infra. (2) The reducer refactor of `src/app/flows/[id]/page.tsx` (1186 lines, 26 useState, actively changed in 5 recent commits, zero component-test coverage) is a large, risky rewrite of a concurrent-hot file — doing it blind, with no component-test harness to catch regressions, repeats the "ship unverified" pattern that caused today's incident. It needs its own plan *after* component-test infra exists. This workstream ships the harness + smoke net; the reducer is written up as a follow-up at the end.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- The auth seam MUST be production-inert: no code path may return an injected auth context when `NODE_ENV === 'production'`. Gate on `NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)`. Default override is null.
- Smoke/DB tests self-skip when `TEST_DATABASE_URL` is unset (standard `if (TEST_DB)` idiom) so `npm test` stays green on dev machines; they run for real in CI (pgvector image, TEST_DATABASE_URL set).
- The smoke suite's pass condition is `status < 500`. Do NOT assert specific 2xx/4xx — a route legitimately 404ing on a missing sub-resource or 400ing on a missing body is not a failure; only an uncaught 5xx is.
- No new npm dependencies. No schema changes.
- Tenant-guard note: the seam returns a real seeded `organizationId`, so routes run their normal org-scoped queries against the seeded tenant — the guard stays active and is exactly what we're exercising.
- Commits direct to `main`; push only at the final task's isolated-worktree gate. Concurrent-session caveat: commit only files you changed.

---

### Task 1: Production-inert auth test seam + route-test helpers

**Files:**
- Modify: `src/lib/server/auth.ts`
- Create: `src/lib/server/__tests__/test-auth.ts` (helper, NOT a `.test.ts` — a support module; name it so the `*.test.ts` glob does not pick it up)
- Test: `src/lib/server/__tests__/auth-seam.test.ts`

**Interfaces:**
- Consumes: `AuthContext`, `requireAuthContext` (existing).
- Produces:
  - In `auth.ts`: `setTestAuthContext(ctx: AuthContext | null): void` and internal `testAuthActive(): boolean`. `requireAuthContext` returns the injected context (skipping Supabase + all gates) when `testAuthActive()` and an override is set.
  - In `test-auth.ts`: `seedTestOrg(prisma): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }>` and `installTestAuth(auth): void` / `clearTestAuth(): void` wrappers. Task 2 consumes these.

- [ ] **Step 1: Write the failing seam test**

`src/lib/server/__tests__/auth-seam.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTestAuthContext, requireAuthContext } from '../auth'

test('setTestAuthContext override is ignored in production', async () => {
  const prev = process.env.NODE_ENV
  const prevDb = process.env.TEST_DATABASE_URL
  ;(process.env as Record<string, string>).NODE_ENV = 'production'
  process.env.TEST_DATABASE_URL = 'postgres://x'
  setTestAuthContext({ organizationId: 'o', userId: 'u', dbUser: { id: 'u' } as never, user: { id: 'u' } as never })
  // In production the override must NOT short-circuit — requireAuthContext must
  // fall through to the real (here, unconfigured) Supabase path and reject.
  await assert.rejects(() => requireAuthContext())
  setTestAuthContext(null)
  ;(process.env as Record<string, string>).NODE_ENV = prev as string
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('setTestAuthContext override is honored under test gating', async () => {
  const prevDb = process.env.TEST_DATABASE_URL
  process.env.TEST_DATABASE_URL = 'postgres://x' // NODE_ENV is 'test' under tsx --test
  const ctx = { organizationId: 'o1', userId: 'u1', dbUser: { id: 'u1' } as never, user: { id: 'u1' } as never }
  setTestAuthContext(ctx)
  const resolved = await requireAuthContext()
  assert.equal(resolved.organizationId, 'o1')
  assert.equal(resolved.userId, 'u1')
  setTestAuthContext(null)
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('with no override, requireAuthContext ignores the seam entirely', async () => {
  setTestAuthContext(null)
  await assert.rejects(() => requireAuthContext()) // no Supabase configured in unit env
})
```

Note: confirm `process.env.NODE_ENV` is `'test'` under `tsx --test` (it is by default for node:test). If it is undefined in this repo's runner, the second test's gate still needs `NODE_ENV !== 'production'` — which holds. Run to see the actual value and adjust the assertion prose only, never the production-inert gate.

- [ ] **Step 2: Run — verify RED**

Run: `npx tsx --test src/lib/server/__tests__/auth-seam.test.ts`
Expected: FAIL — `setTestAuthContext` not exported.

- [ ] **Step 3: Implement the seam in `auth.ts`**

At module scope (after the imports):

```ts
// Production-inert test seam: mirrors src/lib/observability/sentry.ts's
// injectable reporter. A route smoke test injects a seeded auth context so it
// can drive real handlers without a Supabase session. NEVER active in
// production — double-gated on NODE_ENV and TEST_DATABASE_URL (production sets
// neither), and null by default so real auth runs unless a test injects.
let testAuthContext: AuthContext | null = null

export function setTestAuthContext(ctx: AuthContext | null): void {
  testAuthContext = ctx
}

function testAuthActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}
```

At the very TOP of `requireAuthContext`, before `getAuthWithUser()`:

```ts
  if (testAuthContext && testAuthActive()) return testAuthContext
```

- [ ] **Step 4: Run — verify GREEN**

Run: `npx tsx --test src/lib/server/__tests__/auth-seam.test.ts`
Expected: PASS all three.

- [ ] **Step 5: Write the test-support helper**

`src/lib/server/__tests__/test-auth.ts` (NOT matched by the `*.test.ts` glob — it exports helpers, runs no tests):

```ts
import crypto from 'node:crypto'
import { setTestAuthContext } from '../auth'
import type { AuthContext } from '../auth'

/** Seed an org + active user and return an AuthContext bound to them. */
export async function seedTestOrg(prisma: any): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }> {
  const org = await prisma.organization.create({ data: { name: 'Smoke', slug: `smoke-${crypto.randomUUID()}` } })
  const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
  const auth: AuthContext = {
    organizationId: org.id,
    userId: user.id,
    dbUser: user,
    user: { id: user.supabaseId } as never,
  }
  const cleanup = async () => {
    setTestAuthContext(null)
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
  return { organizationId: org.id, userId: user.id, auth, cleanup }
}

export function installTestAuth(auth: AuthContext): void {
  setTestAuthContext(auth)
}
export function clearTestAuth(): void {
  setTestAuthContext(null)
}
```

Confirm the `AuthContext.user` shape the routes actually read — if any route reads `auth.user.email` or similar, widen the stub. (Most read only `auth.organizationId` / `auth.dbUser.id`.)

- [ ] **Step 6: Full gate + commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/server/auth.ts src/lib/server/__tests__/auth-seam.test.ts src/lib/server/__tests__/test-auth.ts
git commit -m "test(auth): production-inert auth seam + seedTestOrg helper — lets DB tests drive real route handlers"
```

---

### Task 2: Route smoke suite — no authenticated GET route may 500

**Files:**
- Create: `src/app/api/__tests__/route-smoke.test.ts`

**Interfaces:**
- Consumes: `seedTestOrg`/`clearTestAuth` from Task 1; `NextRequest` from `next/server`; the exported route handlers.

- [ ] **Step 1: Write the smoke suite**

`src/app/api/__tests__/route-smoke.test.ts`. DB-gated. For each route: import its handler, build a `NextRequest`, call it, assert `res.status < 500`. Start with the no-`[id]` GET routes plus the two incident regressions (chat/sessions + agent-templates), seeding an agent for the id-bearing ones:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off' // seam skips gates anyway; belt-and-suspenders

  let prisma: any
  let seeded: any
  let agentId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const agent = await prisma.agentTask.create({
      data: { description: 'a', objective: 'o', status: 'ACTIVE', agentType: 'assistant', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    agentId = agent.id
  })

  after(async () => {
    await seeded.cleanup()
  })

  const req = (path: string) => new NextRequest(new URL(`http://test${path}`))

  // (handler import, request, expected-non-5xx) — extend as routes are added.
  const cases: Array<{ name: string; run: () => Promise<Response> }> = [
    { name: 'GET /api/agent-templates', run: async () => (await import('../../agent-templates/route')).GET(req('/api/agent-templates')) },
    { name: 'GET /api/notifications', run: async () => (await import('../../notifications/route')).GET(req('/api/notifications')) },
    { name: 'GET /api/snapshot', run: async () => (await import('../../snapshot/route')).GET(req('/api/snapshot')) },
    { name: 'GET /api/flows', run: async () => (await import('../../flows/route')).GET(req('/api/flows')) },
    { name: 'GET /api/agents', run: async () => (await import('../../agents/route')).GET(req('/api/agents')) },
    // Incident regression: these 500'd under the tenant guard before the sweep.
    { name: 'GET /api/agents/[id]/chat/sessions', run: async () => (await import('../../agents/[id]/chat/sessions/route')).GET(req(`/api/agents/${agentId}/chat/sessions`)) },
  ]

  for (const c of cases) {
    test(`${c.name} does not 500`, async () => {
      const res = await c.run()
      assert.ok(res.status < 500, `${c.name} returned ${res.status}: ${await res.clone().text().catch(() => '')}`)
    })
  }
}
```

Implementer notes:
- Some GET handlers read `request.nextUrl.searchParams` — `NextRequest` provides `nextUrl`, so `new NextRequest(new URL(...))` is sufficient.
- Dynamic `[id]` routes derive the id from the URL via a helper (`agentIdFromRequest` reads `request.nextUrl.pathname`) — pass a real seeded id in the URL, as shown for chat/sessions.
- ENUMERATE the actual no-`[id]` GET routes by listing `src/app/api/**/route.ts` and checking which export `GET` wrapped in `withAuthenticatedApi`; add each as a case. If a route needs a query param to avoid a 400 (not a 500), that's fine — a 400 passes. Skip routes that require an external service call that would hang (note any you skip and why).
- If any case surfaces a REAL 500 (a genuine bug like the incident), FIX the route (add org scoping / handle the null) and note it prominently in your report — that is the harness doing its job.

- [ ] **Step 2: Run against a throwaway pgvector DB**

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r6' -c 'CREATE DATABASE ws_r6'
psql -h localhost -d ws_r6 -c 'CREATE EXTENSION IF NOT EXISTS vector'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r6 DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r6 npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r6 DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r6 DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r6 ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npx tsx --test src/app/api/__tests__/route-smoke.test.ts
```
Expected: all cases pass (status < 500). Drop the DB after. To PROVE the net works, temporarily revert one route's org scoping locally and confirm the smoke test goes red — describe this in your report (do not commit the revert).

- [ ] **Step 3: Full gate + commit**

```bash
git add src/app/api/__tests__/route-smoke.test.ts
git commit -m "test(api): route smoke suite — authenticated GET handlers must not 500 (guard-incident regression net)"
```

---

### Task 3: Docs, CI-mode gate, push, final review

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `docs/superpowers/plans/2026-07-10-remediation-ws6-route-smoke-harness.md` (append the Phase-2 reducer write-up)

- [ ] **Step 1: ARCHITECTURE.md** — under the testing/known-follow-ups area (read the file), add:

```markdown
API routes are smoke-tested end to end: `src/app/api/__tests__/route-smoke.test.ts` invokes real `withAuthenticatedApi` handlers against a seeded test DB (via the production-inert auth seam in `src/lib/server/auth.ts`) and fails on any 5xx — the regression net for unscoped-query/guard failures. It runs in CI where `TEST_DATABASE_URL` is set.
```

- [ ] **Step 2: Append the Phase-2 reducer write-up** to this plan file (a short section: goal — carve `page.tsx`'s 26 useState into a typed reducer + context; prerequisite — a React component-test harness (Testing Library or Playwright component testing) so the refactor is regression-covered; risk — concurrent-hot file, coordinate; explicitly NOT done in WS-R6).

- [ ] **Step 3: Isolated-worktree gate** — worktree at HEAD, symlink node_modules; typecheck/lint/test; recreate `ci_repro` WITH `CREATE EXTENSION vector`, `migrate deploy`, DB-backed `npm test` (the smoke suite un-skips and runs), `npm run build`.

- [ ] **Step 4: Push + CI green** — the smoke suite runs for the first time in CI on the pgvector image; watch it.

- [ ] **Step 5: Final whole-workstream review** (controller dispatches; capable model; verify the seam is production-inert by inspection and that the smoke net actually asserts <500, not something weaker).
