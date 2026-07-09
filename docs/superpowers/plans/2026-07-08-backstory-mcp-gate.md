# Backstory MCP Native Connection + Onboarding Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec `docs/superpowers/specs/2026-07-08-backstory-mcp-gate-design.md`: every user gets a seeded per-user Backstory MCP connection (`https://mcp.backstory.ai/mcp`, OAuth 2.0), and a hard gate blocks the platform until the signed-in user has authorized it.

**Architecture:** Extend `McpConnection` with nullable `userId`/`provider`/`lastVerifiedAt` (hand-authored migration, applied by `prisma migrate deploy` on Vercel). A new `src/lib/mcp/backstory-connection.ts` module owns seeding + the gate decision (pure evaluators + cached resolver). `requireAuthContext` enforces the gate (403 `BACKSTORY_MCP_REQUIRED`) with an opt-out flag for the few setup routes. The existing MCP OAuth start/callback routes gain a `connectionId`/`returnTo` re-auth mode. `/connect` becomes a two-step setup; a `SetupGate` in the app shell redirects unconnected users there; the connections UI locks provider-managed cards.

**Tech Stack:** Next.js 15 App Router, Prisma 6 (Postgres), zod, existing MCP OAuth authcode machinery (`oauth-authcode.ts`, `connection-token.ts`), `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- Tests: `node:test` + `node:assert/strict` in `__tests__/*.test.ts`; components/routes have no test infra — pure functions get tests, routes get typecheck+lint.
- Local env has no DB/Supabase vars: NEVER run `npm run dev`, `npm run build`, `prisma migrate dev`, or `prisma db push`. Migrations are hand-authored SQL files applied on Vercel by `prisma migrate deploy`. Run `npx prisma generate` after schema edits so types compile.
- Verification everywhere: `npm run typecheck && npm run lint && npm test` (expect 291+ pass / 6 skip; 4 pre-existing lint warnings in untouched test files).
- Exact values: server URL default `https://mcp.backstory.ai/mcp` (env override `BACKSTORY_MCP_URL`); gate env flag `BACKSTORY_MCP_GATE` (`on`/`off`, default on in production only); error code `BACKSTORY_MCP_REQUIRED` (403); CRUD rejection code `PROVIDER_MANAGED` (403); provider value `'backstory'`; connection name `Backstory MCP`.
- Never log or return raw tokens; secrets stay encrypted via the existing `encryptSecret` helpers.

---

### Task 1: Schema + migration — userId/provider/lastVerifiedAt on McpConnection

**Files:**
- Modify: `prisma/schema.prisma` (McpConnection model + User back-relation)
- Create: `prisma/migrations/<UTC-timestamp>_mcp_connection_user_provider/migration.sql`

**Interfaces:**
- Produces: `McpConnection.userId: string | null`, `.provider: string | null`, `.lastVerifiedAt: Date | null` on the Prisma client. Every later task relies on these fields.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, replace the `McpConnection` model with:

```prisma
model McpConnection {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  // Personal connection when set (e.g. the per-user Backstory MCP row);
  // null = org-shared server added via the connections page.
  userId         String?
  // Platform-managed provider slug ('backstory'); null = user-added server.
  provider       String?
  name           String
  description    String?
  serverUrl      String
  authType       String    @default("none")   // 'none' | 'api_key' | 'oauth2'
  authConfig     Json      @default("{}")     // encrypted secret blob + non-secret fields
  isActive       Boolean   @default(true)
  lastVerifiedAt DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  organization  Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user          User?            @relation(fields: [userId], references: [id], onDelete: Cascade)
  agentBindings AgentConnector[]

  @@index([organizationId, isActive])
  @@index([organizationId, userId, provider])
  @@map("mcp_connections")
}
```

Add the back-relation to the `User` model (match how `PeopleAiConnection`'s user relation is declared there — same list-field style): `mcpConnections McpConnection[]`.

IMPORTANT: before writing the migration, check the `User` model's `id` column type in schema.prisma (uuid vs text) and mirror the `userId` column type + FK exactly the way the `people_ai_connections` table's migration did (look at the latest migration files under `prisma/migrations/` that reference `"users"` for the exact referenced table/column names).

- [ ] **Step 2: Hand-author the migration**

Create `prisma/migrations/<UTC-timestamp>_mcp_connection_user_provider/migration.sql` (timestamp format matching sibling folders, e.g. `20260708T000000` style used there):

```sql
ALTER TABLE "mcp_connections" ADD COLUMN "userId" TEXT;
ALTER TABLE "mcp_connections" ADD COLUMN "provider" TEXT;
ALTER TABLE "mcp_connections" ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);

CREATE INDEX "mcp_connections_organizationId_userId_provider_idx"
  ON "mcp_connections"("organizationId", "userId", "provider");

ALTER TABLE "mcp_connections"
  ADD CONSTRAINT "mcp_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Adjust `"users"("id")` and the `userId` column type to exactly match the `people_ai_connections` FK in the existing migrations (Step 1's check). If `User.id` is `@db.Uuid`, use `ADD COLUMN "userId" UUID`.

- [ ] **Step 3: Regenerate the client and verify**

Run: `npx prisma generate && npm run typecheck && npm run lint && npm test`
Expected: all clean (generation only; no DB is touched locally).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(mcp): add userId/provider/lastVerifiedAt to McpConnection"
```

---

### Task 2: backstory-connection module — seeding + gate decision

**Files:**
- Create: `src/lib/mcp/backstory-connection.ts`
- Test: `src/lib/mcp/__tests__/backstory-connection.test.ts`

**Interfaces:**
- Produces (Tasks 3-6 depend on these exact names):
  - `BACKSTORY_MCP_DEFAULT_URL = 'https://mcp.backstory.ai/mcp'`
  - `backstoryServerUrl(): string`
  - `backstoryGateEnabled(): boolean`
  - `evaluateBackstoryReady(row: { isActive: boolean; authConfig: unknown } | null): boolean` (pure)
  - `ensureBackstoryConnection(organizationId: string, userId: string): Promise<void>` (idempotent, never throws)
  - `backstoryMcpReady(organizationId: string, userId: string): Promise<boolean>` (60s in-process cache)
  - `bustBackstoryReadyCache(organizationId: string, userId: string): void`
  - `readyCacheFresh(cachedAt: number, now?: number): boolean` (pure, exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mcp/__tests__/backstory-connection.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateBackstoryReady,
  backstoryGateEnabled,
  backstoryServerUrl,
  readyCacheFresh,
  BACKSTORY_MCP_DEFAULT_URL,
} from '../backstory-connection'

test('evaluateBackstoryReady requires an active row with authcode tokens', () => {
  assert.equal(evaluateBackstoryReady(null), false)
  assert.equal(evaluateBackstoryReady({ isActive: false, authConfig: { flow: 'authcode', accessToken: 'enc' } }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: {} }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: { flow: 'authcode' } }), false)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: { flow: 'authcode', accessToken: 'enc' } }), true)
  assert.equal(evaluateBackstoryReady({ isActive: true, authConfig: 'not-an-object' }), false)
})

test('backstoryGateEnabled follows BACKSTORY_MCP_GATE with production default', () => {
  const prior = { gate: process.env.BACKSTORY_MCP_GATE, env: process.env.NODE_ENV }
  try {
    process.env.BACKSTORY_MCP_GATE = 'on'
    assert.equal(backstoryGateEnabled(), true)
    process.env.BACKSTORY_MCP_GATE = 'off'
    assert.equal(backstoryGateEnabled(), false)
    delete process.env.BACKSTORY_MCP_GATE
    assert.equal(backstoryGateEnabled(), process.env.NODE_ENV === 'production')
  } finally {
    if (prior.gate === undefined) delete process.env.BACKSTORY_MCP_GATE
    else process.env.BACKSTORY_MCP_GATE = prior.gate
  }
})

test('backstoryServerUrl defaults and honors the env override', () => {
  const prior = process.env.BACKSTORY_MCP_URL
  try {
    delete process.env.BACKSTORY_MCP_URL
    assert.equal(backstoryServerUrl(), BACKSTORY_MCP_DEFAULT_URL)
    process.env.BACKSTORY_MCP_URL = 'https://custom.example.com/mcp'
    assert.equal(backstoryServerUrl(), 'https://custom.example.com/mcp')
  } finally {
    if (prior === undefined) delete process.env.BACKSTORY_MCP_URL
    else process.env.BACKSTORY_MCP_URL = prior
  }
})

test('readyCacheFresh is a 60s TTL', () => {
  const now = 1_000_000
  assert.equal(readyCacheFresh(now - 59_000, now), true)
  assert.equal(readyCacheFresh(now - 61_000, now), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/mcp/__tests__/backstory-connection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/lib/mcp/backstory-connection.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/** The natively-included Backstory MCP server every user connects to. */
export const BACKSTORY_MCP_DEFAULT_URL = 'https://mcp.backstory.ai/mcp'
export const BACKSTORY_PROVIDER = 'backstory'

export function backstoryServerUrl(): string {
  return process.env.BACKSTORY_MCP_URL?.trim() || BACKSTORY_MCP_DEFAULT_URL
}

/**
 * The Backstory MCP gate is enforced in production; in development it
 * defaults off so a fresh clone works. Force with BACKSTORY_MCP_GATE=on|off.
 */
export function backstoryGateEnabled(): boolean {
  const flag = process.env.BACKSTORY_MCP_GATE
  if (flag === 'on') return true
  if (flag === 'off') return false
  return process.env.NODE_ENV === 'production'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Pure gate decision over the user's Backstory connection row. */
export function evaluateBackstoryReady(row: { isActive: boolean; authConfig: unknown } | null): boolean {
  if (!row || !row.isActive) return false
  const config = row.authConfig
  if (!isRecord(config)) return false
  return config.flow === 'authcode' && typeof config.accessToken === 'string' && config.accessToken.length > 0
}

const READY_TTL_MS = 60_000
export function readyCacheFresh(cachedAt: number, now: number = Date.now()): boolean {
  return now - cachedAt < READY_TTL_MS
}

const readyCache = new Map<string, { ready: boolean; cachedAt: number }>()
const seededMemo = new Set<string>()
const cacheKey = (organizationId: string, userId: string) => `${organizationId}:${userId}`

export function bustBackstoryReadyCache(organizationId: string, userId: string): void {
  readyCache.delete(cacheKey(organizationId, userId))
}

/**
 * Idempotently seed the per-user Backstory MCP row (inactive until OAuth
 * completes). Never throws — sign-in must not be blocked by the seeder.
 */
export async function ensureBackstoryConnection(organizationId: string, userId: string): Promise<void> {
  const key = cacheKey(organizationId, userId)
  if (seededMemo.has(key)) return
  try {
    const existing = await prisma.mcpConnection.findFirst({
      where: { organizationId, userId, provider: BACKSTORY_PROVIDER },
      select: { id: true },
    })
    if (!existing) {
      await prisma.mcpConnection.create({
        data: {
          organizationId,
          userId,
          provider: BACKSTORY_PROVIDER,
          name: 'Backstory MCP',
          description: 'Native Backstory tools',
          serverUrl: backstoryServerUrl(),
          authType: 'oauth2',
          authConfig: {},
          isActive: false,
        },
      })
    }
    seededMemo.add(key)
  } catch (error) {
    apiLogger.warn('Backstory MCP seeding failed; will retry next request', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Cached (60s) gate check: does this user have an authorized Backstory row? */
export async function backstoryMcpReady(organizationId: string, userId: string): Promise<boolean> {
  const key = cacheKey(organizationId, userId)
  const cached = readyCache.get(key)
  if (cached && readyCacheFresh(cached.cachedAt)) return cached.ready
  const row = await prisma.mcpConnection.findFirst({
    where: { organizationId, userId, provider: BACKSTORY_PROVIDER },
    select: { isActive: true, authConfig: true },
  })
  const ready = evaluateBackstoryReady(row)
  readyCache.set(key, { ready, cachedAt: Date.now() })
  return ready
}
```

- [ ] **Step 4: Run tests, verify pass, full suite**

Run: `npx tsx --test src/lib/mcp/__tests__/backstory-connection.test.ts && npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/backstory-connection.ts src/lib/mcp/__tests__/backstory-connection.test.ts
git commit -m "feat(mcp): backstory connection seeding + gate decision module"
```

---

### Task 3: Gate enforcement — requireAuthContext, handler flag, setup-status route

**Files:**
- Modify: `src/lib/server/auth.ts`
- Modify: `src/lib/server/api-handler.ts`
- Create: `src/app/api/setup/status/route.ts`
- Modify: exempt routes — `src/app/api/mcp-connections/oauth/start/route.ts`, `.../oauth/discover/route.ts`, `.../oauth/test/route.ts`, and whichever of `src/app/api/peopleai/connect|callback|status/route.ts` use `withAuthenticatedApi` (grep; raw `NextRequest` handlers like the MCP oauth callback need no change).

**Interfaces:**
- Consumes: Task 2's `ensureBackstoryConnection`, `backstoryMcpReady`, `backstoryGateEnabled`.
- Produces: `requireAuthContext(options?: { skipBackstoryGate?: boolean })`; `withAuthenticatedApi(handler, options?: { skipBackstoryGate?: boolean })`; `GET /api/setup/status` → `{ success: true, entitled: boolean, backstoryConnected: boolean, backstoryConnectionId: string | null, backstoryServerUrl: string }`. Task 6's UI consumes the status shape verbatim.

- [ ] **Step 1: Extend requireAuthContext**

In `src/lib/server/auth.ts`, add the import:

```ts
import { backstoryGateEnabled, backstoryMcpReady, ensureBackstoryConnection } from '@/lib/mcp/backstory-connection'
```

Change the signature to `export async function requireAuthContext(options?: { skipBackstoryGate?: boolean }): Promise<AuthContext>` and, directly after the `entitlementGateEnabled()` block, add:

```ts
  // Native Backstory MCP: seed the per-user connection row (idempotent, never
  // throws), then hard-gate the platform until the user has authorized it.
  await ensureBackstoryConnection(auth.organizationId, auth.dbUser.id)
  if (!options?.skipBackstoryGate && backstoryGateEnabled()) {
    const ready = await backstoryMcpReady(auth.organizationId, auth.dbUser.id)
    if (!ready) {
      throw new AuthContextError(
        'Connect your Backstory MCP account to continue.',
        403,
        'BACKSTORY_MCP_REQUIRED',
      )
    }
  }
```

- [ ] **Step 2: Thread the flag through withAuthenticatedApi**

In `src/lib/server/api-handler.ts`:

```ts
export function withAuthenticatedApi(
  handler: AuthenticatedHandler,
  options?: { skipBackstoryGate?: boolean },
) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const auth = await requireAuthContext(options)
      …
```

(only the two lines shown change; the rest of the function is untouched).

- [ ] **Step 3: Exempt the setup routes**

For each of these route files, add the second argument `,{ skipBackstoryGate: true }` to their `withAuthenticatedApi(...)` call:
- `src/app/api/mcp-connections/oauth/start/route.ts`
- `src/app/api/mcp-connections/oauth/discover/route.ts`
- `src/app/api/mcp-connections/oauth/test/route.ts`
- Any of `src/app/api/peopleai/connect/route.ts`, `.../callback/route.ts`, `.../status/route.ts` that use `withAuthenticatedApi` (grep each; skip raw handlers).
- Also `src/app/api/mcp-connections/route.ts` GET/POST/PUT/DELETE handlers get the flag too — the /connect page and connections page must be able to list/manage connections before the gate passes (the gate's purpose is to block the *product*, not the setup surfaces; Task 5 separately locks provider rows).

- [ ] **Step 4: Create the setup-status route**

Create `src/app/api/setup/status/route.ts`:

```ts
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { entitlementGateEnabled } from '@/lib/server/auth'
import { resolveEntitlement } from '@/lib/entitlement'
import { prisma } from '@/lib/prisma'
import {
  BACKSTORY_PROVIDER,
  backstoryMcpReady,
  backstoryServerUrl,
  ensureBackstoryConnection,
} from '@/lib/mcp/backstory-connection'

export const runtime = 'nodejs'

// GET /api/setup/status — the onboarding gate's single source of truth for the
// client. Exempt from the gate itself so /connect and the SetupGate can load.
export const GET = withAuthenticatedApi(
  async (_request, auth) => {
    await ensureBackstoryConnection(auth.organizationId, auth.dbUser.id)
    const [entitlement, backstoryConnected, row] = await Promise.all([
      entitlementGateEnabled() ? resolveEntitlement(auth.organizationId) : Promise.resolve({ entitled: true }),
      backstoryMcpReady(auth.organizationId, auth.dbUser.id),
      prisma.mcpConnection.findFirst({
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id, provider: BACKSTORY_PROVIDER },
        select: { id: true },
      }),
    ])
    return {
      success: true,
      entitled: Boolean(entitlement.entitled),
      backstoryConnected,
      backstoryConnectionId: row?.id ?? null,
      backstoryServerUrl: backstoryServerUrl(),
    }
  },
  { skipBackstoryGate: true },
)
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

```bash
git add src/lib/server/auth.ts src/lib/server/api-handler.ts src/app/api/setup/status/route.ts src/app/api/mcp-connections src/app/api/peopleai
git commit -m "feat(gate): enforce Backstory MCP requirement in auth context with setup exemptions"
```

---

### Task 4: OAuth re-auth mode — connectionId + returnTo + scope on start/callback

**Files:**
- Modify: `src/app/api/mcp-connections/oauth/start/route.ts`
- Modify: `src/app/api/mcp-connections/oauth/callback/route.ts`

**Interfaces:**
- Consumes: Task 2's `bustBackstoryReadyCache`.
- Produces: `GET /api/mcp-connections/oauth/start?connectionId=<id>&returnTo=<path>[&scope=<scope>]` re-authorizes an existing row in place; the callback updates that row (`isActive: true`, `lastVerifiedAt`), busts the ready cache, and redirects to `returnTo`. The legacy `serverUrl`+`name` create mode is unchanged. Task 6's Connect buttons use exactly this URL shape.

- [ ] **Step 1: Start route — accept connectionId/returnTo/scope**

In the start route, after reading `serverUrl`/`name`, add:

```ts
  const connectionId = request.nextUrl.searchParams.get('connectionId')?.trim() || undefined
  const returnToRaw = request.nextUrl.searchParams.get('returnTo')?.trim() || undefined
  // Same-origin paths only — never an absolute URL.
  const returnTo = returnToRaw && returnToRaw.startsWith('/') && !returnToRaw.startsWith('//') ? returnToRaw : undefined
  const scope = request.nextUrl.searchParams.get('scope')?.trim() || 'claudeai'
```

When `connectionId` is present, load the row instead of requiring `serverUrl`/`name` params:

```ts
  let effectiveServerUrl = serverUrl
  let effectiveName = name
  if (connectionId) {
    const row = await prisma.mcpConnection.findFirst({
      where: { id: connectionId, organizationId: auth.organizationId },
      select: { id: true, serverUrl: true, name: true, userId: true },
    })
    // Personal rows may only be re-authorized by their owner.
    if (!row || (row.userId && row.userId !== auth.dbUser.id)) {
      return NextResponse.redirect(new URL('/connections?error=oauth_params', request.nextUrl.origin))
    }
    effectiveServerUrl = row.serverUrl
    effectiveName = row.name
  }
  if (!effectiveServerUrl || !effectiveName) { …existing oauth_params redirect… }
```

(add `import { prisma } from '@/lib/prisma'`; replace subsequent uses of `serverUrl`/`name` with the effective variables, including discovery and the cookie payload). Pass `scope` to `buildAuthorizeUrl` in place of the hardcoded `'claudeai'`. Extend the sealed cookie payload with `connectionId`, `returnTo`, and `userId: auth.dbUser.id`.

- [ ] **Step 2: Callback route — update-in-place mode**

In the callback's `OAuthCookiePayload` interface add `connectionId?: string`, `returnTo?: string`, `userId?: string`. After building `authConfig`, replace the unconditional `create` with:

```ts
    if (payload.connectionId) {
      await prisma.mcpConnection.update({
        where: { id: payload.connectionId },
        data: {
          authType: 'oauth2',
          authConfig: authConfig as Prisma.InputJsonValue,
          isActive: true,
          lastVerifiedAt: new Date(),
        },
      })
      if (payload.userId) bustBackstoryReadyCache(payload.organizationId, payload.userId)
    } else {
      await prisma.mcpConnection.create({ …existing create data… })
    }
```

Add the import `import { bustBackstoryReadyCache } from '@/lib/mcp/backstory-connection'`. Change the success redirect to honor `returnTo`:

```ts
    const successPath = payload.returnTo && payload.returnTo.startsWith('/') && !payload.returnTo.startsWith('//')
      ? `${payload.returnTo}${payload.returnTo.includes('?') ? '&' : '?'}connected=1`
      : '/connections?connected=1'
    const response = NextResponse.redirect(new URL(successPath, request.nextUrl.origin))
    response.cookies.set(OAUTH_COOKIE, '', { path: '/', maxAge: 0 })
    return response
```

(the error paths keep redirecting to `/connections?error=…` — except when `payload?.returnTo` exists, in which case redirect the `error=oauth` case there instead so /connect can show the retry CTA: use the same same-origin check.)

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/api/mcp-connections/oauth/start/route.ts' 'src/app/api/mcp-connections/oauth/callback/route.ts'
git commit -m "feat(mcp): oauth re-auth mode — connectionId, returnTo, scope param"
```

---

### Task 5: Consumption filters + provider-managed CRUD guards

**Files:**
- Modify: `src/app/api/mcp-connections/route.ts` (list filter, serializer, PUT/DELETE guards)
- Modify: `src/lib/flows/tool-catalog.ts` (userId filter)
- Modify: `src/app/api/flows/tool-catalog/route.ts` (pass userId)
- Modify: `src/features/flows/execute-flow.ts` (pass userId)
- Modify: `src/features/agents/execute-agent.ts` (userId filter on the McpConnection block; skip legacy env Backstory path when a user row is bound)
- Test: `src/lib/flows/__tests__/tool-catalog-filter.test.ts` (new; filter builder only)

**Interfaces:**
- Consumes: schema fields from Task 1.
- Produces: `mcpConnectionScope(organizationId: string, userId?: string)` exported from `src/lib/flows/tool-catalog.ts` — the shared Prisma `where` fragment `{ organizationId, isActive: true, OR: [{ userId: null }, { userId }] }` (OR omitted when no userId). `loadFlowToolCatalog(organizationId, options?: { userId?: string; connectionIds?: string[]; takeConnections?: number; takeTools?: number })`.

- [ ] **Step 1: Write the failing filter test**

Create `src/lib/flows/__tests__/tool-catalog-filter.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpConnectionScope } from '../tool-catalog'

test('scope without userId matches org-shared rows only semantics (no OR clause)', () => {
  assert.deepEqual(mcpConnectionScope('org1'), { organizationId: 'org1', isActive: true })
})

test('scope with userId includes org-shared and own personal rows', () => {
  assert.deepEqual(mcpConnectionScope('org1', 'user1'), {
    organizationId: 'org1',
    isActive: true,
    OR: [{ userId: null }, { userId: 'user1' }],
  })
})
```

Run: `npx tsx --test src/lib/flows/__tests__/tool-catalog-filter.test.ts` — expect FAIL (no export).

- [ ] **Step 2: Implement the scope + thread userId**

In `src/lib/flows/tool-catalog.ts` add and use:

```ts
/** Shared connection visibility: org-shared rows plus the acting user's own. */
export function mcpConnectionScope(organizationId: string, userId?: string) {
  return userId
    ? { organizationId, isActive: true, OR: [{ userId: null }, { userId }] }
    : { organizationId, isActive: true }
}
```

Add `userId?: string` to `loadFlowToolCatalog`'s options and build its `findMany` `where` from `{ ...mcpConnectionScope(organizationId, options?.userId), ...(connectionIds ? { id: { in: connectionIds } } : {}) }` (keep existing take/ordering behavior).

Thread the caller user:
- `src/app/api/flows/tool-catalog/route.ts`: pass `{ userId: auth.dbUser.id }`.
- `src/features/flows/execute-flow.ts`: the `loadFlowToolCatalog(job.organizationId, { connectionIds: … })` call adds `userId: job.userId`.
- `src/features/agents/execute-agent.ts`: locate the per-org McpConnection `findMany({ where: { organizationId, isActive: true … } })` block (~line 388) and apply the same OR clause with the execution user's id (the job carries it — match the variable in scope there). In the legacy env-based Backstory block (`backstoryMcpConfigured()` branch, ~line 355), first check whether the loaded rows will include a ready Backstory provider row for this user (`prisma.mcpConnection.findFirst({ where: { organizationId, userId, provider: 'backstory', isActive: true }, select: { id: true } })`); when found, skip the env block and log `apiLogger.info('Backstory MCP bound via per-user connection; env service-account path skipped')` — otherwise keep the env path and add a deprecation note to its existing log line.

- [ ] **Step 3: CRUD list filter, serializer, and provider guards**

In `src/app/api/mcp-connections/route.ts`:
- GET: `where: { organizationId: auth.organizationId, OR: [{ userId: null }, { userId: auth.dbUser.id }] }`.
- `serializeConnection`: add `provider: conn.provider`, `userId: conn.userId`, `lastVerifiedAt: conn.lastVerifiedAt` to both the input type and the returned object.
- PUT and DELETE handlers: after loading the target row (they already fetch/verify org ownership — locate that), add:

```ts
  if (existing.provider) {
    throw new ApiError('This connection is managed by the platform and cannot be edited or deleted.', 403, 'PROVIDER_MANAGED')
  }
```

- [ ] **Step 4: Verify and commit**

Run: `npx tsx --test src/lib/flows/__tests__/tool-catalog-filter.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/tool-catalog.ts src/lib/flows/__tests__/tool-catalog-filter.test.ts src/app/api/mcp-connections/route.ts src/app/api/flows/tool-catalog/route.ts src/features/flows/execute-flow.ts src/features/agents/execute-agent.ts
git commit -m "feat(mcp): per-user connection scoping across catalog, runtimes, and CRUD"
```

---

### Task 6: UI — two-step /connect, SetupGate, locked provider cards

**Files:**
- Modify: `src/app/connect/page.tsx` (two-step setup)
- Create: `src/components/layout/setup-gate.tsx`
- Modify: `src/components/layout/app-shell.tsx` (wrap app routes with SetupGate)
- Modify: `src/app/connections/page.tsx` (provider-managed card treatment)

**Interfaces:**
- Consumes: `GET /api/setup/status` (Task 3 shape), OAuth start URL shape (Task 4), serializer fields `provider`/`lastVerifiedAt` (Task 5).

- [ ] **Step 1: SetupGate component**

Create `src/components/layout/setup-gate.tsx`:

```tsx
'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

type SetupStatus = { entitled: boolean; backstoryConnected: boolean }

/**
 * Hard onboarding gate for app routes: until the signed-in user has an
 * authorized Backstory MCP connection, every app surface redirects to the
 * /connect setup flow. Server APIs enforce the same rule (403
 * BACKSTORY_MCP_REQUIRED) — this component is the navigation counterpart.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (data?.success) {
          if (!data.backstoryConnected) {
            window.location.assign('/connect')
            return
          }
          setStatus({ entitled: Boolean(data.entitled), backstoryConnected: true })
        } else {
          // Status endpoint failed (401 handled by middleware; transient 5xx):
          // fail open so an outage doesn't lock the product. APIs still gate.
          setStatus({ entitled: true, backstoryConnected: true })
        }
      })
      .catch(() => {
        if (!cancelled) setStatus({ entitled: true, backstoryConnected: true })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!status) {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <>{children}</>
}
```

In `src/components/layout/app-shell.tsx`, import it and wrap both content branches' `<ErrorBoundary>{children}</ErrorBoundary>` as `<ErrorBoundary><SetupGate>{children}</SetupGate></ErrorBoundary>` (app routes only — the early-return public branch stays untouched).

- [ ] **Step 2: /connect two-step setup**

Rework `src/app/connect/page.tsx`'s `ConnectInner` to render two sequential step cards inside the existing card shell (keep the header, error banners, and styling classes already there):

- On mount, `fetch('/api/setup/status', { cache: 'no-store' })` → `{ entitled, backstoryConnected, backstoryConnectionId }` in state (plus a `loading` flag; render the existing copy skeleton-free — just disable buttons until loaded).
- **Step 1 — Sales AI entitlement:** the existing copy + `Connect Backstory` anchor (`/api/peopleai/connect?return_to=/connect`). When `entitled`, render a green `Check` row "Sales AI connected" instead of the CTA.
- **Step 2 — Backstory MCP:** a bordered row showing name `Backstory MCP`, the server URL (from status `backstoryServerUrl`), and an `OAuth 2.0` badge. CTA:

```tsx
<a
  href={`/api/mcp-connections/oauth/start?connectionId=${backstoryConnectionId ?? ''}&returnTo=/connect`}
  className="…same button classes as the existing CTA…"
>
  Connect Backstory MCP <ArrowRight className="h-4 w-4" />
</a>
```

  When `backstoryConnected`, render the green Check row "Backstory MCP connected". Disable the CTA when `backstoryConnectionId` is null (seed not yet visible).
- Query params: keep the existing `peopleai` status banners; additionally handle `connected=1` (green banner) and `error=oauth`/`error=oauth_state`/`error=oauth_start`/`error=oauth_params` (amber banner "The Backstory MCP connection didn't complete. Try again.").
- When both `entitled` (or step 1 CTA hidden because entitlement gate reports entitled) and `backstoryConnected`, auto-forward: `window.location.assign('/dashboard')` after a 1200ms timeout.

- [ ] **Step 3: Connections page provider-card lockdown**

In `src/app/connections/page.tsx`:
- Extend `SerializedConnection` (or the local type used for cards) with `provider?: string | null` and `lastVerifiedAt?: string | null`.
- In the card render, when `conn.provider` is truthy:
  - Hide the Active `Switch`, Edit, and Delete controls.
  - Show a status pill instead: `conn.isActive ? 'Active' : 'Needs authorization'` (`Badge` with green/amber styling consistent with the page).
  - Show a `Reauthorize` button: `<a href={`/api/mcp-connections/oauth/start?connectionId=${conn.id}&returnTo=/connections`} …>Reauthorize</a>` styled like the existing small outline buttons.
  - Keep the OAuth badge and server URL display as-is.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add src/components/layout/setup-gate.tsx src/components/layout/app-shell.tsx src/app/connect/page.tsx src/app/connections/page.tsx
git commit -m "feat(gate): two-step connect setup, app-shell gate, locked provider cards"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green (Task 2 + Task 5 tests add to the count).

- [ ] **Step 2: Reasoning smoke checklist**

Confirm in code review terms:
- Fresh user sign-in → row seeded inactive → API 403 `BACKSTORY_MCP_REQUIRED` on product routes → SetupGate redirects to /connect → Connect CTA → OAuth → callback updates row + busts cache + returns to /connect → auto-forward to dashboard.
- Setup routes (setup-status, mcp-connections CRUD + oauth, peopleai) all reachable pre-gate.
- Flow tool catalog and agent runs see the user's Backstory row; teammates' rows invisible.
- Provider cards: no edit/delete (UI + `PROVIDER_MANAGED` API), Reauthorize works.
- `BACKSTORY_MCP_GATE=off` (dev default) keeps local behavior unchanged.

- [ ] **Step 3: Done**

OAuth loop + gate UX validate end-to-end on the Vercel preview against the real `mcp.backstory.ai`.

Known follow-up (spec §3 simplification): `evaluateBackstoryReady` checks token presence, not freshness — a revoked grant keeps `backstoryConnected: true` until the row is deactivated. Detecting permanent refresh failure and flipping `isActive` false belongs to a follow-up on `ensureFreshConnectionToken`.
