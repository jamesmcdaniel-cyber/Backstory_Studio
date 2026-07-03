# Backstory Studio → People.ai Sales AI delivery surface — Program Spec

**Date:** 2026-07-02
**Status:** Approved for phased implementation; revised with People.ai contracts
**Owner:** James McDaniel

## 1. What we are building

Backstory Studio becomes the **external-facing delivery surface for People.ai
Sales AI** (People.ai's SalesAI product is brand-named "Backstory"; its MCP
server is `mcp.people.ai`). People.ai delivers value — signals like risk
detected, engagement changed, score updated — inside their product. This program
surfaces that value *outside* People.ai, in the tools reps live in (Slack,
Gmail, Salesforce, Notion), by letting entitled customers build agents that
consume People.ai signals and act on them.

## 2. The pivotal insight from the People.ai contracts

`mcp.people.ai` is **both an MCP server and an OAuth 2.0 authorization server**.
Its OAuth flow delegates sign-in to Glass → Salesforce and returns a user
identity plus `mcp_*` tokens scoped to that user's People.ai permissions. This
means one integration does the work of three:

- **Identity** — the user authenticates as their real Salesforce/People.ai self.
- **Entitlement** — completing the flow and receiving a SalesAI-scoped context
  (team/org id + membership id) *is* proof the user is an entitled Sales AI
  customer. Access is "based on the user's permissions within People.ai."
- **Data spine** — the same `mcp_*` token calls the 8 SalesAI tools, and because
  the token is user-scoped, **data isolation is automatic** — an agent only reads
  what that rep can see. Gap 2 (shared service account) is solved natively by
  using the per-user OAuth token instead of the current client-credentials key.

The existing `BACKSTORY_MCP_*` seam already talks to `mcp.people.ai` via the
**service-credentials** path (`client_credentials` / `PAI-Client-*`). We keep
that for non-interactive service runs and **add the per-user OAuth path** as the
primary identity.

## 3. People.ai integration contract (from provided docs)

**MCP server:** StreamingHTTP, endpoint `https://mcp.people.ai/mcp`.

**OAuth (per-user, primary):**
- Discovery: `https://mcp.people.ai/.well-known/oauth-authorization-server`
- Authorize: `https://mcp.people.ai/authorize`
- Token / Refresh: `https://mcp.people.ai/token`
- PKCE (authcode + code_verifier/code_challenge). Issues `mcp_*` access +
  refresh tokens. Flow internally: MCP → Glass (`glass.people.ai`) → Salesforce
  login → back to MCP. Token context exposes `pai_token`, `org_id` (team id),
  `membership_id`, `scopes`.
- **We must obtain from People.ai:** a registered OAuth `client_id` /
  `client_secret` and assigned **scope** for "Backstory Studio" (Claude uses
  `claudeai`, Copilot uses `copilot` — we get our own), and our **redirect URI
  whitelisted** on Glass (Glass validates the callback host).

**API key (service, secondary):** headers `PAI-Client-Id` / `PAI-Client-Secret`
(or `gt_{client_id}:{client_secret}` bearer). Access scoped to the key's
permissions, independent of a user login. Used for signal-driven runs with no
interactive user.

**Tools (8, read):** `find_account`, `ask_sales_ai_about_account`,
`ask_sales_ai_about_opportunity`, `get_recent_account_activity`,
`get_recent_opportunity_activity`, `get_account_status`,
`get_opportunity_status`, `account_company_news`.

**SalesAI webhooks (signals):**
- Register: `POST /v1/salesai/webhooks` (People.ai SalesAI API,
  `api.people.ai`).
- Events: `deal.score_updated`, `deal.risk_detected`, `deal.stage_changed`,
  `forecast.updated`, `insight.generated`, `stakeholder.engagement_changed`.
- Payloads documented with examples; mapped on receipt to our `Signal` model.

**Entitlement API:** no standalone doc located. **Resolution:** derive
entitlement from People.ai OAuth success + presence of SalesAI context
(team_id/membership_id) — a real, documented signal, not a stub. Keep an
`EntitlementResolver` seam so a dedicated entitlement endpoint drops in later if
engineering exposes one (open question tracked in §8).

## 4. Locked decisions

- **People.ai MCP OAuth is the identity + entitlement + read-spine**, via the
  existing `McpConnection` authcode infrastructure, per-user.
- **Gate model: Model B (recommended).** Studio keeps its Supabase account layer,
  but the app is **gated on a valid per-user People.ai connection**; entitlement,
  org (= People.ai team id), and membership derive from the People.ai token
  context. Open password signup off in production (invite/SSO only). Model A
  (People.ai as the primary login IdP, replacing Supabase) is a future upgrade if
  People.ai exposes a login-grade OIDC IdP — deferred (YAGNI now).
- **Tool plane: keep both, cleanly divided.** People.ai MCP + Klavis = read
  tools; **Nango = outbound delivery** (Slack/Gmail/Salesforce writes) with
  **per-user delivery identity**. A single runtime **tool registry** merges them;
  each tool tracks provenance (`people_ai | klavis | nango | native`).
- **Spec + phased plan first**, then execute phase-by-phase with review gates.

## 5. Data model additions (all additive)

- `Organization` += `peopleAiTeamId String? @unique`, `entitlementTier String?`,
  `entitlementStatus String @default("unknown")`, `entitlementCheckedAt DateTime?`.
- `User` += `peopleAiMembershipId String?`.
- `McpConnection` (exists, authcode-capable) stores the per-user People.ai
  connection: `mcp_*` access/refresh tokens (encrypted), scope, `provider =
  "people_ai"`, `userId`.
- `Signal` — inbound People.ai events: `org`, `type` (the 6 events), entity refs
  (`accountId?`, `opportunityId?`, `stakeholderId?`), `payload Json`,
  `dedupeKey @unique`, `provenanceUrl?`, `receivedAt`, `processedAt?`.
- `SignalSubscription` — routing: `org`, `signalType`, `filter Json`,
  `agentTaskId`, `deliveryPref Json`, `isActive`.
- `AgentExecution` += `idempotencyKey String?` (unique per org) + `signalId String?`.
- `AuditEvent` — append-only: `org`, `actor`, `action`, `resource`, `tool`,
  `payloadHash`, `ip?`, `createdAt`.
- `ApprovalRequest` — outbound-write gate: `org`, `executionId`, `tool`,
  `payload Json`, `status`, `decidedBy?`, `decidedAt?`.
- `NangoConnection` (exists) — start populating `userId` for per-user delivery.

## 6. Architecture by pillar

### 6.1 The gate (Gap 1)
- Login page offers **"Connect People.ai"** — runs the MCP OAuth authcode+PKCE
  client flow against `mcp.people.ai`, stores the per-user `McpConnection`, and
  reads `org_id`/`membership_id` from the returned context.
- `provisionUser` no longer mints an org per signup. It maps
  `peopleAiTeamId` → the single `Organization` for that team (created once; first
  user = admin), so every rep from a customer shares one workspace.
- `requireAuthContext` calls `EntitlementResolver.resolve(org)` — today: "has an
  active People.ai connection with SalesAI context" → entitled; cached on
  `Organization` with a TTL; a scheduled revalidation clears access when the
  People.ai token can no longer be refreshed (license revoked).
- Middleware blocks unentitled/unconnected sessions with a clear "Connect your
  People.ai Sales AI account to continue" screen, not a broken app. Password
  signup gated behind `AUTH_ALLOW_PASSWORD` (off in prod).

### 6.2 The spine — identity + read (Gaps 2)
- Refactor `backstory-mcp.ts` into a client that accepts an **auth strategy**:
  (a) per-user `mcp_*` bearer from the caller's `McpConnection` (primary), or
  (b) service `PAI-Client-*` credentials (signal/non-interactive runs).
- At execution, People.ai tools resolve the **agent owner's** connection and
  call `mcp.people.ai/mcp` as that user, with automatic refresh via `/token`.
  Service key is used only when no user context exists, logged to audit.

### 6.3 The spine — signals (Gap 3)
- On connect (or org setup), register a webhook via `POST /v1/salesai/webhooks`
  pointing at `POST /api/signals/people-ai`.
- Receiver: HMAC-verify, dedupe (`dedupeKey`), persist `Signal`, return 202,
  enqueue routing. Maps the 6 event types to structured entity refs.
- Router: match `signalType` + `filter` against `SignalSubscription`; for each,
  enqueue an execution with the signal as **structured context** and
  `idempotencyKey = signalId:agentId` (unique index prevents double-fire on
  replay).
- UI: Signals browser (with `provenanceUrl` back to People.ai) + subscription
  builder ("when `deal.risk_detected` on a deal → draft a check-in in Gmail").
- Stopgap if webhook registration isn't available per-tenant: an MCP poller on a
  schedule feeding the same router.

### 6.4 The arm — tool plane (Gap 4)
- Runtime **tool registry** merges People.ai (read, 8 tools) + Klavis (read/MCP)
  + Nango delivery + native (Granola) into one deduped list, provenance-tagged.
- Nango **delivery adapters**: typed `slack.postMessage`, `gmail.sendEmail`,
  `salesforce.*` from `nango.getConnection()`, preferring the **per-user** Nango
  connection (DM/email as the rep) over the org connection.
- Optional future: CRM write-back through People.ai/Glass to Salesforce "where
  supported" (docs hint) — not in initial scope.

### 6.5 Durability (Gap 5)
- `EXECUTION_MODE=queue` default in prod; BullMQ worker (`Dockerfile.worker`,
  `render.yaml` present) deployed as a Render service. Retries+backoff, per-org
  concurrency caps, dead-letter queue. Token budgets tie to `entitlementTier`.

### 6.6 Trust envelope (Gap 6)
- Append-only `AuditEvent` for every agent action + tool write; per-org export.
- Approval gates: outbound writes can park in `waiting_for_input` with an
  `ApprovalRequest` (primitive exists) until approved.
- Rate limiting on public endpoints (signal receiver, webhook triggers, auth).
- `ENCRYPTION_KEY` becomes a **hard startup failure** in prod (no base64
  fallback).

### 6.7 Foundation (Gap 7)
- CI: add a test job + `prisma migrate deploy` against a shadow DB; **baseline**
  migration history so `migrate deploy` becomes the deploy path (end hand-applied
  SQL). Branch protection on `main`, PR-required, a **staging** Vercel env.
  Sentry error tracking. `OPENAI_API_KEY` set in Vercel. `DIRECT_URL` → 5432.

## 7. Phasing & dependencies

| Phase | Gap | Blocked on People.ai? | Notes |
|---|---|---|---|
| 0 — Foundation & safety | 7 + secrets/rate-limit | No | Ship first; makes deploys safe |
| 1 — The gate + People.ai identity | 1, 2 | Needs registered OAuth client_id/secret + scope + redirect whitelisting | Merged: one People.ai-OAuth flow delivers both |
| 2 — Signals ingestion | 3 | Needs webhook signing secret; events documented | Platform-side buildable now |
| 3 — Tool plane / delivery | 4 | No | Nango delivery adapters + registry |
| 4 — Durability | 5 | No | Queue-by-default + worker deploy |
| 5 — Trust envelope | 6 | No | Audit, approvals, rate limits |

Gaps 1 and 2 **merge** into one phase because a single People.ai MCP OAuth
integration provides identity, entitlement, and the read spine together.

## 8. Open questions (need People.ai / eng)
1. **OAuth client registration** for Backstory Studio: `client_id`,
   `client_secret`, assigned `scope`, and redirect-URI whitelisting on Glass.
   *(Blocks Phase 1 go-live; platform code builds against the flow now.)*
2. **Webhook signing:** signature header name + secret provisioning for
   `/v1/salesai/webhooks`. *(Blocks Phase 2 go-live.)*
3. **Dedicated entitlement API** (if any) vs. deriving from OAuth+SalesAI
   context. *(Non-blocking; seam ready.)*
4. **Per-tenant webhook registration** availability, or use the MCP poller
   stopgap.

## 9. Out of scope (YAGNI)
- Model A (People.ai as primary login IdP replacing Supabase).
- Multi-org-per-user membership.
- CRM write-back via Glass (future).
- A billing system (entitlement is read from People.ai, not sold here).

## 10. Success criteria
- An un-entitled visitor can never reach the app; an entitled rep clicks
  "Connect People.ai", authenticates via Salesforce, and lands in their team's
  workspace.
- A `deal.risk_detected` webhook → routed → agent run (reading People.ai as that
  rep) → Slack DM to the owning rep, with a provenance link and an audit entry;
  a replayed webhook produces no second action.
- Schema changes deploy via CI `migrate deploy`; no hand-applied prod SQL.
