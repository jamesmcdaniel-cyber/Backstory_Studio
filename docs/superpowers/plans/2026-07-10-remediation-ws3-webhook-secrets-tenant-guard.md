# Remediation WS-R3: Per-Org People.ai Webhook Secrets + Prisma Tenant-Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two structural trust gaps from the architecture audit: the People.ai signals receiver's single global HMAC secret (which lets any secret-holder inject signals into ANY org by picking a `team_id`), and convention-only tenant isolation (every query hand-appends `organizationId` with no enforcement backstop).

**Architecture:** (A) Each Organization gets its own webhook signing secret, minted when its `peopleAiTeamId` is bound during People.ai connect and rotatable by an org admin; the receiver resolves the candidate org from the (untrusted) payload, then verifies the HMAC against THAT org's secret — binding authenticity to tenancy. Orgs without a per-org secret fall back to the global env secret during migration. (B) The shared Prisma client gains a `$extends` query guard: any read/update/delete on an org-carrying model whose `where` lacks `organizationId` (anywhere in the tree, including relation filters) throws loudly. A separately-exported `systemPrisma` (unguarded) serves the enumerated legitimate system paths — cron sweeps, reapers, tenant resolution, auth bootstrap, worker-internal id-keyed writes — each annotated at the call site. The guard is a guardrail that converts silent scoping omissions into loud failures, not a substitute for RLS.

**Tech Stack:** Prisma 6 client extensions (`$extends({ query: { $allModels } })`), AES-256-GCM secret storage (`encryptSecret`), existing HMAC scheme (`signPayload`/`verifySignature` in src/lib/signals/verify.ts), node:test.

**Scope Note:** Postgres RLS is deliberately out of scope (bigger migration, Supabase-role plumbing); the client-side guard is the audit's recommended structural backstop. Per-org secrets for OTHER webhook surfaces (agent/flow trigger secrets) already exist and are untouched. Removing the global-secret fallback is a follow-up once People.ai-side registration is migrated.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent (match surrounding files exactly).
- DB-backed tests must self-skip when `TEST_DATABASE_URL` is unset (existing `if (TEST_DB)` gating pattern).
- ONE schema migration is allowed (Task 1's `peopleAiWebhookSecret` column). Generate it with `prisma migrate dev` pointed at a THROWAWAY local DB only (e.g. `ws_r3_migrate`) — never a real env DATABASE_URL. CI's migrate-from-zero + drift jobs validate it.
- No new dependencies.
- Secrets: signing secrets are stored ENCRYPTED (reversible, `encryptSecret` — HMAC verification needs the plaintext), never logged, never in error messages; API responses may return the plaintext only from the admin-gated mint/rotate/reveal route.
- The tenant guard must throw a descriptive error naming the model, operation, and the two remedies (add `organizationId` to the where, or use `systemPrisma` with a justification comment). Guard failures must never be swallowed.
- `systemPrisma` call sites each carry a one-line justification comment.
- Verification gate per task: `npm run typecheck && npm run lint && npm test`. Final Task: ci_repro DB gate + build in an isolated worktree (a concurrent session may have WIP in the shared tree), push, CI green check.
- Commits go directly to `main`. Do not push until the final task's gate.

---

### Task 1: Per-org People.ai webhook signing secrets

**Files:**
- Modify: `prisma/schema.prisma` (Organization: add `peopleAiWebhookSecret String?` — encrypted-at-rest, comment it)
- Create: `prisma/migrations/<timestamp>_org_peopleai_webhook_secret/migration.sql` (via `prisma migrate dev --name org_peopleai_webhook_secret` against a throwaway local DB)
- Create: `src/lib/peopleai/webhook-secret.ts`
- Modify: `src/lib/peopleai/connect-service.ts` (mint on team binding)
- Create: `src/app/api/peopleai/webhook-secret/route.ts` (admin-gated GET reveal / POST rotate)
- Modify: `src/app/api/signals/people-ai/route.ts` (per-org verification with global fallback)
- Test: extend `src/app/api/signals/people-ai/__tests__/receiver.test.ts`; create `src/lib/peopleai/__tests__/webhook-secret.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (src/lib/crypto/secrets.ts), `verifySignature`/`signPayload` (src/lib/signals/verify.ts), `withAuthenticatedApi` + role check pattern (see src/app/api/organizations/route.ts for the ADMIN-gate idiom), `completeConnect` (src/lib/peopleai/connect-service.ts).
- Produces: `mintWebhookSecret(): string` (random 32-byte base64url), `ensureOrgWebhookSecret(organizationId: string): Promise<string>` (mint+store if absent, return existing plaintext otherwise), `orgWebhookSecret(organizationId: string): Promise<string | null>` — all in `src/lib/peopleai/webhook-secret.ts`. Task 3 does NOT depend on this task.

- [ ] **Step 1: Schema + migration**

In `prisma/schema.prisma`, inside `model Organization`, after `peopleAiTeamId String? @unique`, add:

```prisma
  /// HMAC signing secret for this org's People.ai webhook deliveries.
  /// Stored encrypted (src/lib/crypto/secrets.ts encryptSecret) — verification
  /// needs the plaintext, so this is NOT a hash. Null = org falls back to the
  /// global PEOPLE_AI_WEBHOOK_SECRET during migration.
  peopleAiWebhookSecret String?
```

Generate the migration against a throwaway DB:

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r3_migrate' -c 'CREATE DATABASE ws_r3_migrate'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_migrate DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_migrate npx prisma migrate dev --name org_peopleai_webhook_secret
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r3_migrate'
```

Expected: a new folder under `prisma/migrations/` containing `ALTER TABLE "organizations" ADD COLUMN "peopleAiWebhookSecret" TEXT;` (confirm the table name matches the schema's `@@map`).

- [ ] **Step 2: Write failing tests for the secret helpers**

Create `src/lib/peopleai/__tests__/webhook-secret.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ws-r3-test-key'

test('mintWebhookSecret returns a distinct high-entropy token each call', async () => {
  const { mintWebhookSecret } = await import('../webhook-secret')
  const a = mintWebhookSecret()
  const b = mintWebhookSecret()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let ensureOrgWebhookSecret: any
  let orgWebhookSecret: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ensureOrgWebhookSecret, orgWebhookSecret } = await import('../webhook-secret'))
    const org = await prisma.organization.create({ data: { name: 'Whs', slug: `whs-${Date.now()}` } })
    ids.org = org.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('ensureOrgWebhookSecret mints once and is stable across calls', async () => {
    const first = await ensureOrgWebhookSecret(ids.org)
    const second = await ensureOrgWebhookSecret(ids.org)
    assert.equal(first, second)
    const row = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.ok(row.peopleAiWebhookSecret)
    assert.notEqual(row.peopleAiWebhookSecret, first) // stored encrypted, not plaintext
  })

  test('orgWebhookSecret returns the plaintext, or null when unset', async () => {
    assert.equal(await orgWebhookSecret(ids.org), await ensureOrgWebhookSecret(ids.org))
    const bare = await prisma.organization.create({ data: { name: 'Whs2', slug: `whs2-${Date.now()}` } })
    assert.equal(await orgWebhookSecret(bare.id), null)
    await prisma.organization.delete({ where: { id: bare.id } })
  })
}
```

Run: `npx tsx --test src/lib/peopleai/__tests__/webhook-secret.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the helpers**

Create `src/lib/peopleai/webhook-secret.ts`:

```ts
/**
 * Per-organization People.ai webhook signing secrets.
 *
 * The receiver verifies each delivery's HMAC against the TARGET org's own
 * secret, so possessing one org's secret cannot authenticate a payload that
 * names another org's team_id. Secrets are stored encrypted (reversible —
 * HMAC verification needs the plaintext), minted when the org's
 * peopleAiTeamId is first bound, and rotatable by an org admin.
 */

import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

export function mintWebhookSecret(): string {
  return `pai_whsec_${randomBytes(32).toString('base64url')}`
}

/** Mint and persist a secret if the org has none; return the plaintext either way. */
export async function ensureOrgWebhookSecret(organizationId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  if (org?.peopleAiWebhookSecret) return decryptSecret(org.peopleAiWebhookSecret)
  const secret = mintWebhookSecret()
  // Guarded write: only fill an empty slot, so a concurrent mint cannot
  // overwrite a secret another request just stored (last-write-wins here
  // would invalidate a secret already handed to People.ai).
  const claimed = await prisma.organization.updateMany({
    where: { id: organizationId, peopleAiWebhookSecret: null },
    data: { peopleAiWebhookSecret: encryptSecret(secret) },
  })
  if (claimed.count === 1) return secret
  const winner = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  if (!winner?.peopleAiWebhookSecret) throw new Error('Failed to persist webhook secret')
  return decryptSecret(winner.peopleAiWebhookSecret)
}

/** The org's plaintext signing secret, or null if none minted yet. */
export async function orgWebhookSecret(organizationId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  return org?.peopleAiWebhookSecret ? decryptSecret(org.peopleAiWebhookSecret) : null
}

/** Rotate: overwrite unconditionally, return the new plaintext. */
export async function rotateOrgWebhookSecret(organizationId: string): Promise<string> {
  const secret = mintWebhookSecret()
  await prisma.organization.update({
    where: { id: organizationId },
    data: { peopleAiWebhookSecret: encryptSecret(secret) },
  })
  return secret
}
```

Run the test file again → PASS (pure test everywhere; DB tests under TEST_DATABASE_URL).

- [ ] **Step 4: Mint on team binding in connect-service**

In `src/lib/peopleai/connect-service.ts`, in `completeConnect`, immediately after the `prisma.organization.update({ ... data: { peopleAiTeamId: identity.teamId } })` call (the first-connector-claims branch) AND in the already-bound path, add a best-effort mint (import at top: `import { ensureOrgWebhookSecret } from './webhook-secret'`):

```ts
  // Best-effort: give the org its per-tenant webhook signing secret as soon
  // as its team binding exists. Failure must not break connect — the
  // receiver falls back to the global secret until a secret is minted.
  try {
    await ensureOrgWebhookSecret(input.organizationId)
  } catch (error) {
    captureError(error, { source: 'peopleai.connect.webhookSecret', organizationId: input.organizationId })
  }
```

Place it once, after the team-binding if/else resolution completes (so it runs for both the claim path and the already-bound path) and before the `peopleAiConnection.upsert`. Use the file's existing `captureError` import if present; add it if not.

- [ ] **Step 5: Admin reveal/rotate route**

Create `src/app/api/peopleai/webhook-secret/route.ts`. Read `src/app/api/organizations/route.ts` first and mirror its ADMIN-gate + `withAuthenticatedApi` idiom exactly. Behavior:

- `GET`: ADMIN only. Returns `{ success: true, secret: <plaintext or null>, configured: <boolean> }` — reveal is acceptable because the store is reversible by design and the admin needs the value to register the webhook on the People.ai side. Non-admin → the same 403 shape `organizations/route.ts` uses.
- `POST`: ADMIN only. Calls `rotateOrgWebhookSecret(auth.organizationId)`, returns `{ success: true, secret }`. Audit it if the file's siblings audit config changes; otherwise skip (audit-coverage expansion is out of scope).

Both handlers operate ONLY on `auth.organizationId` — no org id from the request.

- [ ] **Step 6: Receiver verifies against the target org's secret**

In `src/app/api/signals/people-ai/route.ts`, restructure the verification order. Current order: read env secret → verify → parse → resolve org. New order (comment the trust reasoning inline):

```ts
  const globalSecret = process.env.PEOPLE_AI_WEBHOOK_SECRET || null
  const rawBody = await request.text()
  const header =
    request.headers.get('x-peopleai-signature') ||
    request.headers.get('x-pai-signature') ||
    request.headers.get('x-signature')

  // Parse BEFORE verifying only to discover which org's secret governs this
  // delivery — the payload stays untrusted until the HMAC check passes.
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const record = payload as Record<string, unknown>
  const teamId = [record.team_id, record.org_id, (record.data as Record<string, unknown> | undefined)?.team_id]
    .map((value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null))
    .find(Boolean)
  const organization = teamId
    ? await prisma.organization.findUnique({
        where: { peopleAiTeamId: teamId },
        select: { id: true, peopleAiWebhookSecret: true },
      })
    : null

  // Per-org secret binds authenticity to tenancy: a signature is only valid
  // if produced with the TARGET org's own secret. Orgs that haven't minted
  // one yet fall back to the global secret. An org WITH a secret never
  // accepts the global one — otherwise the global secret would still reach
  // every tenant.
  const orgSecret = organization?.peopleAiWebhookSecret
    ? decryptSecret(organization.peopleAiWebhookSecret)
    : null
  const secret = orgSecret ?? globalSecret
  if (!secret) {
    return NextResponse.json(
      { success: false, error: 'Signal webhooks are not configured for this environment.' },
      { status: 503 },
    )
  }
  if (!verifySignature({ rawBody, header, secret })) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }
```

Then continue with the existing mapEventToSignal / unknown-team / signal-create flow — the downstream code already handles `organization === null` (unknown team → 202 dropped); keep that behavior, but note an unknown team now verifies against the global secret (if configured) before being dropped, same as today. Delete the old pre-parse verification block. Import `decryptSecret`. Keep rate limiting first, untouched.

- [ ] **Step 7: Extend receiver tests**

In `src/app/api/signals/people-ai/__tests__/receiver.test.ts` (inside the existing `if (TEST_DB)` block, using its existing helpers/org fixtures — read the file first), add:

```ts
  test('org with a per-org secret accepts only its own signature', async () => {
    const { rotateOrgWebhookSecret } = await import('@/lib/peopleai/webhook-secret')
    const perOrg = await rotateOrgWebhookSecret(ids.org)

    const body = JSON.stringify({ type: EVENT_TYPE, team_id: TEAM, id: `evt-perorg-${Date.now()}`, /* mirror the file's minimal valid event shape */ })
    const okRes = await POST(makeRequest(body, signPayload(body, perOrg)))
    assert.equal(okRes.status, 202)

    const body2 = JSON.stringify({ type: EVENT_TYPE, team_id: TEAM, id: `evt-global-${Date.now()}` })
    const globalRes = await POST(makeRequest(body2, signPayload(body2, 'whsec_receiver_test')))
    assert.equal(globalRes.status, 401) // global secret no longer reaches an org with its own
  })

  test('org without a per-org secret still accepts the global secret', async () => {
    // use a second org fixture with peopleAiTeamId set and NO webhook secret
  })
```

Adapt names (`ids.org`, `TEAM`, `EVENT_TYPE`, `makeRequest`, `POST`) to what the file actually uses — read it first; the two behaviors above are the requirements, verbatim assertions are illustrative. Also reset/clear the org's `peopleAiWebhookSecret` after the first test if fixtures are shared, so existing tests using the global secret keep passing — or order these tests last.

- [ ] **Step 8: Gate + commit**

`npm run typecheck && npm run lint && npm test` (DB tests self-skip locally; they'll run at the final ci_repro gate — if you have a throwaway DB from Step 1 iteration, run the receiver + webhook-secret test files against it directly and include the output in your report).

```bash
git add prisma/schema.prisma prisma/migrations src/lib/peopleai/webhook-secret.ts src/lib/peopleai/__tests__/webhook-secret.test.ts src/lib/peopleai/connect-service.ts src/app/api/peopleai/webhook-secret/route.ts src/app/api/signals/people-ai/route.ts src/app/api/signals/people-ai/__tests__/receiver.test.ts
git commit -m "feat(signals): per-org People.ai webhook secrets — signature validity is bound to the target tenant"
```

---

### Task 2: Prisma tenant-guard extension

**Files:**
- Modify: `src/lib/prisma.ts`
- Create: `src/lib/tenant-guard.ts`
- Test: `src/lib/__tests__/tenant-guard.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `prisma` (now guarded) and `systemPrisma` (unguarded, for enumerated system paths) exported from `src/lib/prisma.ts`; `whereHasOrgScope(where: unknown): boolean` and `ORG_SCOPED_MODELS: ReadonlySet<string>` and `assertOrgScoped(model: string, operation: string, args: unknown): void` from `src/lib/tenant-guard.ts`. Task 3 migrates call sites to `systemPrisma`.

- [ ] **Step 1: Write failing unit tests for the guard logic (pure, no DB)**

Create `src/lib/__tests__/tenant-guard.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whereHasOrgScope, assertOrgScoped, ORG_SCOPED_MODELS } from '../tenant-guard'

test('whereHasOrgScope finds organizationId at any depth', () => {
  assert.equal(whereHasOrgScope({ organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ id: '1', organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ AND: [{ id: '1' }, { organizationId: 'x' }] }), true)
  assert.equal(whereHasOrgScope({ run: { organizationId: 'x' } }), true) // relation filter
  assert.equal(whereHasOrgScope({ execution: { is: { organizationId: 'x' } } }), true)
  assert.equal(whereHasOrgScope({ id: '1' }), false)
  assert.equal(whereHasOrgScope(undefined), false)
  assert.equal(whereHasOrgScope(null), false)
  assert.equal(whereHasOrgScope({}), false)
})

test('assertOrgScoped throws a descriptive error for unscoped reads on org models', () => {
  assert.throws(
    () => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1' } }),
    (error: Error) =>
      error.message.includes('Flow.findFirst') &&
      error.message.includes('organizationId') &&
      error.message.includes('systemPrisma'),
  )
})

test('assertOrgScoped passes scoped queries and non-org models', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1', organizationId: 'o1' } }))
  assert.doesNotThrow(() => assertOrgScoped('WorkflowStep', 'findMany', { where: { executionId: 'e1' } }))
})

test('assertOrgScoped ignores non-where operations and create data', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'create', { data: { name: 'f', organizationId: 'o1' } }))
})

test('ORG_SCOPED_MODELS covers the known org-carrying models', () => {
  for (const model of ['AgentTask', 'AgentExecution', 'Flow', 'FlowRun', 'Signal', 'Notification', 'AuditEvent', 'McpConnection', 'KnowledgeDocument']) {
    assert.ok(ORG_SCOPED_MODELS.has(model), model)
  }
  assert.ok(!ORG_SCOPED_MODELS.has('User')) // nullable orgId — bootstrap queries are org-less by design
  assert.ok(!ORG_SCOPED_MODELS.has('Organization')) // the tenant row itself
})
```

Run → FAIL (module not found).

- [ ] **Step 2: Implement the guard module**

Create `src/lib/tenant-guard.ts`:

```ts
/**
 * Tenant-isolation guardrail for the shared Prisma client.
 *
 * Every read/update/delete on an org-carrying model must scope by
 * organizationId — this codebase's oldest invariant, previously enforced
 * only by convention. The guard turns a silently-unscoped query (a
 * cross-tenant data leak waiting to happen) into a loud error at the call
 * site. It is a guardrail, not a security boundary: Postgres RLS remains
 * the eventual structural fix.
 *
 * Legitimate org-less system paths (cron sweeps, reapers, tenant
 * resolution, worker-internal id-keyed writes) use `systemPrisma` from
 * src/lib/prisma.ts, with a one-line justification comment at each site.
 */

// Org-carrying models with a REQUIRED organizationId (schema.prisma).
// User (nullable orgId, auth bootstrap) and Organization (the tenant row)
// are deliberately excluded. Transitively-scoped children (WorkflowStep,
// FlowRunStep, ExecutionMessage, WorkflowEvent) are excluded — they carry
// no organizationId column; scope them via relation filters when querying
// from user-facing code.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'AgentTask', 'AgentConnector', 'AgentMemory', 'AgentChatMessage', 'AgentChatSession',
  'Signal', 'SignalSubscription', 'CustomSignal', 'AgentExecution', 'Notification',
  'PushSubscription', 'AuditEvent', 'ApprovalRequest', 'AgentTemplate', 'Integration',
  'MCPAgent', 'PeopleAiConnection', 'McpConnection', 'NangoConnection', 'IntegrationSecret',
  'Flow', 'FlowVersion', 'FlowRun', 'KnowledgeDocument', 'KnowledgeChunk', 'SharedSkill',
])

const GUARDED_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
])

/** True when an `organizationId` key appears anywhere in the where tree. */
export function whereHasOrgScope(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false
  if (Array.isArray(where)) return where.some(whereHasOrgScope)
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'organizationId') return true
    if (whereHasOrgScope(value)) return true
  }
  return false
}

export function assertOrgScoped(model: string, operation: string, args: unknown): void {
  if (!ORG_SCOPED_MODELS.has(model)) return
  if (!GUARDED_OPERATIONS.has(operation)) return
  const where = (args as { where?: unknown } | undefined)?.where
  if (whereHasOrgScope(where)) return
  throw new Error(
    `Tenant guard: ${model}.${operation} ran without organizationId in its where clause. ` +
      `Scope the query (add organizationId, or a relation filter that carries it), ` +
      `or — for a legitimate system-wide path — use systemPrisma from '@/lib/prisma' with a justification comment.`,
  )
}
```

Run the unit tests → PASS.

- [ ] **Step 3: Wire the guard into the shared client**

Replace `src/lib/prisma.ts` with:

```ts
import { PrismaClient } from '@prisma/client'
import { assertOrgScoped } from '@/lib/tenant-guard'

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createGuardedClient>
  systemPrisma?: PrismaClient
}

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

function createGuardedClient(base: PrismaClient) {
  // Tenant guard: org-carrying models must be queried with organizationId.
  // See src/lib/tenant-guard.ts. System-wide paths use systemPrisma below.
  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
          return query(args)
        },
      },
    },
  })
}

/**
 * Unguarded client for enumerated system paths ONLY (cron sweeps, reapers,
 * tenant resolution, auth bootstrap, worker-internal id-keyed writes). Every
 * call site carries a one-line justification comment. User-facing code uses
 * `prisma`.
 */
export const systemPrisma = globalForPrisma.systemPrisma ?? createPrismaClient()
globalForPrisma.systemPrisma = systemPrisma

export const prisma = globalForPrisma.prisma ?? createGuardedClient(systemPrisma)
// Cache in all environments: on Vercel this reuses one client (and its pool)
// across warm serverless invocations. The guarded client wraps the SAME
// underlying connection pool as systemPrisma — one pool, two lenses.
globalForPrisma.prisma = prisma
```

Notes for the implementer:
- The extended client type is no longer `PrismaClient` — downstream code that types variables as `PrismaClient` may need `typeof prisma`. `npm run typecheck` will surface every such site; fix them minimally (prefer `typeof prisma` / inferred types over `any`).
- `$transaction` callbacks on the guarded client run through the extension in Prisma 6 (interactive transactions are supported by `$extends`); the existing `prisma.$transaction` call sites keep their guard.

- [ ] **Step 4: Run typecheck + the full local suite — expect failures, and DO NOT fix them in this task**

`npm run typecheck` may surface type-shape issues (fix those here). `npm test` locally (DB tests skipped) should pass. The DB-backed suite (run against a throwaway DB if you want early signal) will FAIL in the org-less system paths — that is Task 3's work. Do NOT migrate call sites in this task; keep this commit to the guard itself so the two changes review independently.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prisma.ts src/lib/tenant-guard.ts src/lib/__tests__/tenant-guard.test.ts
git commit -m "feat(db): tenant guard — org-scoped models refuse unscoped queries; systemPrisma escape hatch for system paths"
```

---

### Task 3: Migrate legitimate org-less call sites to systemPrisma

**Files (the audited inventory — verify each against current code, the concurrent session may have added sites):**
- Modify: `src/app/api/cron/dispatch/route.ts` (agent reaper updateMany; agentTask findMany ACTIVE; flow findMany ACTIVE)
- Modify: `src/app/api/cron/retention/route.ts` (retention sweeps)
- Modify: `src/lib/flows/reap.ts` (stuck-run reaper)
- Modify: `src/app/api/signals/people-ai/route.ts` (signal.create after tenant resolution — the org lookup itself targets Organization, which is unguarded; but `prisma.signal.create` has org in DATA not WHERE — creates are unguarded, verify; the P2002 duplicate lookup if any)
- Modify: `src/lib/signals/router.ts` (signal findUnique by id — internal chaining)
- Modify: `src/lib/peopleai/connect-service.ts` (org lookups are Organization — unguarded; check for any org-less queries on guarded models)
- Modify: `src/lib/supabase/auth-utils.ts` (user bootstrap — User is excluded from the guard; verify no other org-less query)
- Modify: `src/features/agents/execute-agent.ts` (cancellation poll findUnique by execution id; any other worker-internal id-keyed reads/writes)
- Modify: `src/lib/queue/dead-letter.ts` + `src/lib/queue/flow-dead-letter.ts` (id-keyed terminal writes from job data)
- Possibly others: run the DB-backed suite against a throwaway DB and let guard errors enumerate the remainder. EVERY switch to systemPrisma gets a one-line justification comment.

**Interfaces:**
- Consumes: `systemPrisma` from Task 2.
- Produces: a fully green DB-backed suite under the guard.

- [ ] **Step 1: Mechanical migration pass over the audited inventory**

For each file above: change the import to include `systemPrisma`, switch ONLY the org-less queries to it, add the justification comment. Examples of the comment style:

```ts
// systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
// systemPrisma: id-keyed terminal write from worker job data; execution id was minted org-scoped upstream.
// systemPrisma: tenant resolution — this query DISCOVERS the org, so it cannot be org-scoped.
```

Queries in the same file that already carry organizationId stay on `prisma`.

- [ ] **Step 2: Sweep for stragglers with the DB suite**

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r3_guard' -c 'CREATE DATABASE ws_r3_guard'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_guard DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_guard npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_guard DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_guard DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r3_guard ENCRYPTION_KEY=ci-encryption-key npm test 2>&1 | grep -B2 "Tenant guard"
```

Every guard error is either (a) a legitimate system path → systemPrisma + comment, or (b) A REAL SCOPING BUG → fix it by adding organizationId and CALL IT OUT PROMINENTLY in your report (these are the audit's predicted latent leaks — finding one is a win, not a failure). Iterate until the full DB suite is green. Drop the DB when done.

- [ ] **Step 3: Full gate + commit**

`npm run typecheck && npm run lint && npm test` clean.

```bash
git add -A src/
git commit -m "refactor(db): system paths use systemPrisma explicitly — tenant guard now enforced suite-wide"
```

---

### Task 4: Docs, CI-mode gate, push

**Files:**
- Modify: `ARCHITECTURE.md` (tenant-isolation paragraph + per-org webhook secret note)
- Modify: `.superpowers/sdd/progress.md` (ledger — untracked file, updated but not committed)

- [ ] **Step 1: ARCHITECTURE.md**

Replace the sentence `All tenant data queries must include organizationId.` (in Shared Server Utilities) with:

```markdown
All tenant data queries must include `organizationId` — enforced at runtime by a tenant guard on the shared Prisma client (`src/lib/tenant-guard.ts`): org-carrying models refuse reads/updates/deletes whose `where` lacks `organizationId`. Enumerated system-wide paths (cron sweeps, reapers, tenant resolution, worker-internal id-keyed writes) use the unguarded `systemPrisma` export, each with a justification comment.
```

In the paragraph describing the signals receiver (or the Agent Execution section if none exists — read the file), add:

```markdown
People.ai webhook deliveries are verified per-tenant: each organization has its own signing secret (`Organization.peopleAiWebhookSecret`, encrypted at rest), minted at connect time and rotatable by an org admin (`/api/peopleai/webhook-secret`); an org with a secret never accepts the global fallback secret.
```

- [ ] **Step 2: Isolated-worktree CI gate**

Same recipe as WS-R2's Task 3 (worktree at HEAD, symlinked node_modules, typecheck/lint/test; then recreate `ci_repro`, `prisma migrate deploy`, DB-backed `npm test`, `npm run build` — all with the standard placeholder env). Expected: everything green; the migration applies from zero.

- [ ] **Step 3: Commit docs, push, confirm CI**

```bash
git add ARCHITECTURE.md
git commit -m "docs: WS-R3 — tenant guard enforcement + per-org webhook secrets in architecture doc"
git push origin main
curl -s "https://api.github.com/repos/jamesmcdaniel-cyber/Backstory_Studio/actions/runs?per_page=1"  # poll until conclusion: success
```

- [ ] **Step 4: Final whole-workstream review** (controller dispatches per subagent-driven-development; most capable model)
