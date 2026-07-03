# People.ai Delivery Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Backstory Studio into the entitled, People.ai-identity-backed, signal-driven delivery surface for People.ai Sales AI.

**Architecture:** People.ai's `mcp.people.ai` OAuth flow provides user identity, entitlement, and the read data-spine in one; Nango provides per-user outbound delivery; a durable queue runs signal-triggered agents; an enterprise trust envelope and a real CI/deploy foundation make it safe. See spec: `docs/superpowers/specs/2026-07-02-people-ai-delivery-surface-design.md`.

**Tech Stack:** Next.js 15 App Router, React 18, Prisma/Postgres (Supabase), Supabase auth, BullMQ + Redis worker, Nango (`@nangohq/node`), Klavis MCP, Sentry, Zod, Vitest/node:test.

## Global Constraints

- All schema changes **additive only** (new tables / nullable columns / columns with defaults). Never edit an existing migration. New migrations go in `prisma/migrations/` and deploy via CI `prisma migrate deploy`.
- Every API route uses `withAuthenticatedApi` from `src/lib/server/api-handler.ts` and returns `{ success, data?, error?, code? }` envelopes. Every DB query is scoped to `organizationId`.
- Product copy: sentence case, no emoji, calm/declarative, speak to "you", refer to the product as "Backstory". Brand tokens from `src/app/backstory-design.css`; lucide icons.
- Secrets reuse `src/lib/crypto/secrets.ts` (`buildAuthConfig`/`decryptSecret`). No secret is ever returned to the client.
- People.ai endpoints are fixed: MCP `https://mcp.people.ai/mcp`, authorize `/authorize`, token `/token`, discovery `/.well-known/oauth-authorization-server`, webhooks `POST https://api.people.ai/v1/salesai/webhooks`.
- Never run `prisma db push`/`migrate` against a remote DB from a task; migrations apply via CI only.

---

## Phase 0 — Foundation & safety (Gap 7 + secrets/rate-limit of Gap 6)

**Unblocked. Ship first — every later phase deploys through this.** Produces: safe CI/CD, error visibility, hardened secrets, working prod model key.

**File structure:**
- `.github/workflows/ci.yml` (modify) — add test job + shadow-DB `migrate deploy`.
- `src/lib/crypto/secrets.ts` (modify) — hard-fail when `ENCRYPTION_KEY` missing in prod.
- `src/lib/env.ts` (create) — central env validation (Zod), imported at server entry.
- `src/lib/ratelimit.ts` (create) — shared limiter (in-memory dev / Redis prod).
- `src/lib/observability/sentry.ts` (create) + `instrumentation.ts` (create) — error tracking.
- `docs/runbooks/deploy.md` (create) — branch protection, PR flow, staging, migration baseline steps (human/ops actions).

### Task 0.1: ENCRYPTION_KEY hard-fail in production

**Files:** Modify `src/lib/crypto/secrets.ts`; Test `src/lib/crypto/__tests__/secrets.test.ts`.

**Interfaces:** Produces `getEncryptionKey(): Buffer` that throws in prod when unset; `encryptSecret`/`decryptSecret` unchanged signatures.

- [ ] **Step 1:** Write failing test: with `NODE_ENV='production'` and `ENCRYPTION_KEY` unset, `encryptSecret('x')` throws `Error('ENCRYPTION_KEY is required in production')`; with a key set, round-trips; in `development` without a key, still falls back to `b64:` (dev ergonomics preserved).
- [ ] **Step 2:** Run `npx tsx --test src/lib/crypto/__tests__/secrets.test.ts` → FAIL.
- [ ] **Step 3:** Implement: in the key resolver, `if (!raw) { if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is required in production'); console.warn(...base64 fallback...) }`.
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit: `feat(security): hard-fail on missing ENCRYPTION_KEY in production`.

### Task 0.2: Central env validation

**Files:** Create `src/lib/env.ts`; Test `src/lib/__tests__/env.test.ts`.

**Interfaces:** Produces `assertServerEnv(): void` (throws aggregated error listing every missing required var) and `env` (typed getters). Required in prod: `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY`, plus one model key (`OPENAI_API_KEY` **or** `ANTHROPIC_API_KEY`).

- [ ] **Step 1:** Failing test: `assertServerEnv()` with a stubbed empty env throws an error whose message contains every missing var name; with all set, does not throw; passes when only `ANTHROPIC_API_KEY` (no OpenAI) is set.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with a Zod schema + a "at least one model key" refinement; aggregate missing names.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Call `assertServerEnv()` from `instrumentation.ts` (Task 0.4) — noted there.
- [ ] **Step 6:** Commit: `feat: central server env validation`.

### Task 0.3: Shared rate limiter

**Files:** Create `src/lib/ratelimit.ts`; Test `src/lib/__tests__/ratelimit.test.ts`.

**Interfaces:** Produces `rateLimit(key: string, opts: { limit: number; windowMs: number }): Promise<{ ok: boolean; retryAfterMs?: number }>`. Redis-backed when `REDIS_URL` set, else in-memory sliding window.

- [ ] **Step 1:** Failing test (in-memory): 3 calls with `limit:3` ok; 4th returns `{ ok:false, retryAfterMs>0 }`; after `windowMs`, ok again (use injectable clock).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement sliding-window in-memory Map + optional Redis `INCR`/`PEXPIRE`; accept an injectable `now()` for tests.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: shared rate limiter (redis/in-memory)`.

### Task 0.4: Sentry error tracking + instrumentation

**Files:** Create `src/lib/observability/sentry.ts`, `instrumentation.ts`; Modify `src/lib/server/api-handler.ts` (report unhandled errors); Modify `next.config.js` if needed.

**Interfaces:** Produces `captureError(err, ctx?)`. `api-handler` calls it in the `INTERNAL_ERROR` branch. No-op when `SENTRY_DSN` unset.

- [ ] **Step 1:** Failing test: `captureError` with no DSN returns without throwing; `api-handler`'s catch path calls `captureError` (spy) for a non-ApiError.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement thin wrapper around `@sentry/nextjs` guarded on `SENTRY_DSN`; wire into `api-handler` catch; `instrumentation.ts` calls `assertServerEnv()` then Sentry init.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat(observability): Sentry error tracking + startup env assertion`.

### Task 0.5: CI test + migrate-deploy job; migration baseline

**Files:** Modify `.github/workflows/ci.yml`; Create `docs/runbooks/deploy.md`.

- [ ] **Step 1:** Add a `test` job running `npm test` (node:test) after typecheck/lint.
- [ ] **Step 2:** Add a `migrations` job: spin a `postgres` service, run `prisma migrate deploy`, then `prisma migrate diff --exit-code` (schema == migrations) so drift fails CI.
- [ ] **Step 3:** Write `docs/runbooks/deploy.md`: (a) one-time `prisma migrate resolve --applied <each existing migration>` against prod to baseline history (records tonight's hand-applied SQL as applied); (b) enable branch protection on `main` (require PR + CI green); (c) create a Vercel **staging** environment tracking a `staging` branch; (d) set `OPENAI_API_KEY` and fix `DIRECT_URL`→5432 in Vercel. These are human/ops steps — the runbook is the deliverable.
- [ ] **Step 4:** Commit: `ci: test + migrate-deploy jobs; deploy runbook`.

### Task 0.6: Ops actions (human, tracked here)
- [ ] Set `OPENAI_API_KEY` in Vercel (Production+Preview) — or set default model to a `claude-*` id in `AGENT_MODEL`.
- [ ] Fix `DIRECT_URL` to port 5432 in Vercel.
- [ ] Baseline migrations in prod per runbook; enable branch protection; create staging env.

---

## Phase 1 — The gate + People.ai identity (Gaps 1, 2)

**Blocked on §8.1 (OAuth client_id/secret/scope + redirect whitelisting) to go LIVE; platform code builds now against the documented flow.** Produces: People.ai-OAuth login, org=team mapping, entitlement gate, per-user People.ai read tools.

**File structure:**
- `src/lib/peopleai/oauth.ts` (create) — MCP OAuth authcode+PKCE client (discovery, authorize URL, token exchange, refresh).
- `src/lib/peopleai/client.ts` (create, replaces `src/lib/mcp/backstory-mcp.ts` internals) — People.ai MCP client with pluggable auth strategy (per-user `mcp_*` bearer | service `PAI-Client-*`).
- `src/lib/entitlement.ts` (create) — `EntitlementResolver` seam.
- `src/app/api/peopleai/connect/route.ts` + `callback/route.ts` (create) — start/finish OAuth, store `McpConnection`.
- `src/lib/server/auth.ts` (modify) — entitlement check in `requireAuthContext`.
- `src/lib/supabase/auth-utils.ts` (modify) — `provisionUser` maps team→org instead of one-per-signup.
- `src/lib/supabase/middleware.ts` (modify) — gate on connection+entitlement.
- `src/app/auth/*` (modify) — "Connect People.ai" primary; password behind `AUTH_ALLOW_PASSWORD`.
- Prisma: `Organization` (+peopleAiTeamId, entitlement fields), `User` (+peopleAiMembershipId).

**Interfaces (consumed by later phases):**
- `getPeopleAiClientForUser(userId, orgId): PeopleAiClient` — user-scoped read client.
- `getPeopleAiServiceClient(orgId): PeopleAiClient` — service-key client (signals).
- `EntitlementResolver.resolve(org): Promise<{ entitled: boolean; tier: string|null }>`.

**Tasks (each TDD, commit at end):**
- [ ] **1.1** Additive migration + schema: `Organization.peopleAiTeamId @unique`, `entitlementTier`, `entitlementStatus @default("unknown")`, `entitlementCheckedAt`; `User.peopleAiMembershipId`. Test: `prisma validate` + a query round-trip.
- [ ] **1.2** `peopleai/oauth.ts`: build authorize URL with PKCE; exchange code→`mcp_*` tokens; refresh. Tests mock `fetch` against the documented `/authorize`,`/token` shapes.
- [ ] **1.3** `peopleai/client.ts`: MCP StreamingHTTP client with auth strategy; `listTools()`/`callTool()` against `mcp.people.ai/mcp`; refresh-on-401 using stored refresh token. Tests mock transport.
- [ ] **1.4** `entitlement.ts`: resolver — active People.ai connection with SalesAI context (team+membership) ⇒ entitled; cache on `Organization` with TTL; `revalidate(org)` clears when refresh fails. Tests cover entitled/unentitled/expired.
- [ ] **1.5** `/api/peopleai/connect` + `/callback`: run the flow, persist per-user `McpConnection` (encrypted `mcp_*`), set `Organization.peopleAiTeamId` + `User.peopleAiMembershipId` from context. Tests: state/PKCE validation, connection persisted, org mapped.
- [ ] **1.6** `provisionUser` maps `peopleAiTeamId`→existing org (create once; first user admin); no per-signup org. Test: two users, same team ⇒ same org.
- [ ] **1.7** `requireAuthContext` + middleware: block unentitled/unconnected with the "Connect your People.ai Sales AI account" screen; `AUTH_ALLOW_PASSWORD` gates password signup (off in prod). Tests: entitled passes, unentitled 402/redirect.
- [ ] **1.8** Refactor agent runtime (`src/features/agents/execute-agent.ts`) to resolve People.ai tools via `getPeopleAiClientForUser(agent.userId, orgId)`; service client only when no owner, logged to audit. Test: owner token used; fallback path logs.
- [ ] **1.9** Login UI: "Connect People.ai" primary CTA; connection status in the org switcher. Manual verify via `/run`.

---

## Phase 2 — Signals ingestion (Gap 3)

**Platform-side unblocked; go-live needs §8.2 (webhook signing secret).** Produces: signal receipt, routing, idempotent triggered runs, signals UI.

**File structure:**
- Prisma: `Signal`, `SignalSubscription`; `AgentExecution` += `idempotencyKey @unique([orgId,idempotencyKey])`, `signalId`.
- `src/lib/signals/verify.ts` — HMAC verification (seam for People.ai signature header).
- `src/lib/signals/map.ts` — map the 6 event payloads → `Signal` + entity refs.
- `src/lib/signals/router.ts` — match subscriptions, enqueue executions with idempotency.
- `src/app/api/signals/people-ai/route.ts` — receiver (public, rate-limited, HMAC-verified, 202).
- `src/app/api/signal-subscriptions/route.ts` — CRUD (authed, org-scoped).
- `src/app/signals/page.tsx` + components — browse signals (provenance links) + subscription builder.
- `src/lib/peopleai/register-webhook.ts` — `POST /v1/salesai/webhooks` on org setup.

**Tasks:**
- [ ] **2.1** Migration + schema for `Signal`, `SignalSubscription`, execution `idempotencyKey`+`signalId`. Test round-trip + unique index on `[orgId, idempotencyKey]`.
- [ ] **2.2** `signals/verify.ts` HMAC (constant-time) with the documented header; reject bad/missing signature. Tests: valid/invalid/replayed timestamp.
- [ ] **2.3** `signals/map.ts` for all 6 events → typed `Signal` (entity refs + `dedupeKey` + `provenanceUrl`). One test per event using the doc's example payloads.
- [ ] **2.4** Receiver route: verify → dedupe (unique `dedupeKey`) → persist → 202 → enqueue routing; rate-limited. Tests: happy path, duplicate is a no-op 200, bad signature 401.
- [ ] **2.5** `signals/router.ts`: match `signalType`+`filter` JSON against subscriptions; enqueue execution with structured `signal` context + `idempotencyKey=signalId:agentId`; replay ⇒ unique-violation ⇒ skipped. Tests: match/no-match/replay.
- [ ] **2.6** Subscription CRUD API (org-scoped). Tests: create/list/delete, cross-org isolation.
- [ ] **2.7** Signals UI: browser with provenance links + subscription builder wired to CRUD. Manual verify via `/run`.
- [ ] **2.8** `register-webhook.ts` called on org setup/connect; idempotent. Test mocks the People.ai endpoint.

---

## Phase 3 — Tool plane / delivery (Gap 4)

**Unblocked.** Produces: unified tool registry + Nango per-user delivery adapters.

**File structure:**
- `src/features/agents/tool-registry.ts` — merge People.ai + Klavis + Nango + native; dedupe; provenance tags.
- `src/lib/nango/delivery/{slack,gmail,salesforce}.ts` — typed write adapters from `nango.getConnection()`, per-user first.
- `src/features/agents/execute-agent.ts` (modify) — consume the registry.
- `src/app/api/nango/connections/[integrationId]/route.ts` (modify) — support per-user connect.

**Tasks:**
- [ ] **3.1** `tool-registry.ts`: pure merge/dedupe with provenance; unit tests over mixed inputs incl. name collisions.
- [ ] **3.2** Nango delivery adapters (Slack/Gmail/Salesforce), per-user connection preferred over org. Tests mock Nango + provider APIs; assert per-user identity used when present.
- [ ] **3.3** Wire registry into `execute-agent.ts`; Klavis stays read-only source. Test: an agent sees People.ai read tools + Nango delivery tools in one list.
- [ ] **3.4** Per-user Nango connect flow in the integrations UI. Manual verify.

---

## Phase 4 — Runtime durability (Gap 5)

**Unblocked.** Produces: queue-by-default, retries, concurrency caps, dead-letter, deployed worker.

**File structure:**
- `src/lib/queue/execution-mode.ts` (modify) — default `queue` in prod.
- `src/lib/workers/runtime.ts` (modify) — retries/backoff, per-org concurrency, dead-letter queue + handler.
- `render.yaml` (modify) — worker service + Redis wired.
- `src/lib/queue/config.ts` (modify) — DLQ name + options.

**Tasks:**
- [ ] **4.1** Default to `queue` in prod (keep `inline` override for dev). Test: mode resolution by env.
- [ ] **4.2** Worker: bounded retries + exponential backoff; per-org concurrency via grouped queues; failures beyond retries → DLQ. Tests over a mock queue.
- [ ] **4.3** Budget enforcement: tie `AGENT_MONTHLY_TOKEN_LIMIT` to `entitlementTier`. Test tier→limit mapping.
- [ ] **4.4** `render.yaml` worker + Redis; runbook note to deploy. Ops-verified.

---

## Phase 5 — Trust envelope (Gap 6)

**Unblocked.** Produces: audit log + export, approval gates, rate-limit enforcement across public endpoints.

**File structure:**
- Prisma: `AuditEvent`, `ApprovalRequest`.
- `src/lib/audit.ts` — `recordAudit(event)` append-only writer.
- `src/features/agents/execute-agent.ts` (modify) — emit audit on every tool call/write.
- `src/lib/agents/approval.ts` — park outbound writes in `waiting_for_input` + `ApprovalRequest`.
- `src/app/api/audit/export/route.ts` — CSV/JSON export (org-scoped, admin).
- `src/app/api/approvals/route.ts` + UI — list/approve/reject.
- Apply `rateLimit` to signal receiver, webhook triggers, auth routes.

**Tasks:**
- [ ] **5.1** Migration + schema for `AuditEvent`, `ApprovalRequest`. Round-trip tests.
- [ ] **5.2** `audit.ts` append-only writer + emit points in the runtime. Tests: a tool write produces an immutable audit row.
- [ ] **5.3** Approval gate: writes flagged `requiresApproval` park with an `ApprovalRequest`; approve resumes, reject cancels. Tests over the state machine.
- [ ] **5.4** Audit export (admin, org-scoped). Test: CSV shape + isolation.
- [ ] **5.5** Apply `rateLimit` to public endpoints. Tests: limit enforced per route.

---

## Self-review notes
- Every spec §6 pillar maps to a phase; §8 open questions are marked as go-live blockers on their phases, with platform code buildable now.
- No placeholder tasks: each carries files, interfaces, and a test/impl/commit cycle.
- Type consistency: `getPeopleAiClientForUser`/`getPeopleAiServiceClient`, `EntitlementResolver.resolve`, `idempotencyKey=signalId:agentId`, `recordAudit` are used consistently across phases.
- Scope: this is a multi-subsystem program; each phase produces working, testable software on its own and can be its own PR series.
