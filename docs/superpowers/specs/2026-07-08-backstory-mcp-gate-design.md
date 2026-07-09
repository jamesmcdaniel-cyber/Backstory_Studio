# Backstory MCP Native Connection + Onboarding Gate Design

**Date:** 2026-07-08
**Status:** Approved
**Parent:** Workstream 1.5 of `2026-07-08-flow-parity-design.md`
**Goal:** The Backstory MCP server (`https://mcp.backstory.ai/mcp`, OAuth 2.0) is a natively-included connection for every user, and a hard onboarding gate blocks the platform until the signed-in user has authorized it.

## Decisions made

| Decision | Choice |
|---|---|
| Gate strictness | Hard gate: everything blocked after sign-in until OAuth completes; only auth/connect/terms/privacy reachable |
| Ownership | Per user: every user authorizes their own Backstory identity |
| Architecture | Extend `McpConnection` (nullable `userId` + `provider` columns); reuse the existing MCP OAuth authcode routes; extend the existing entitlement-gate pattern |

## Context (verified against the codebase)

- `McpConnection` (`prisma/schema.prisma:516`) is org-scoped only; `authConfig` already stores encrypted authcode tokens.
- The MCP OAuth authorization-code flow is fully implemented: `/api/mcp-connections/oauth/start` (discovery, DCR, PKCE, encrypted `bmcp_oauth` cookie; scope currently hardcoded `'claudeai'`) and `/api/mcp-connections/oauth/callback` (exchange, persist, redirect to `/connections`). Token refresh: `src/lib/mcp/connection-token.ts`.
- Gate precedent: `requireAuthContext` (`src/lib/server/auth.ts`) already runs `assertEntitled` → 403 `ENTITLEMENT_REQUIRED`; `/connect` is the People.ai entitlement front door; only the dashboard client redirects there today.
- `src/lib/flows/tool-catalog.ts` and execute-agent's McpConnection block load rows by `organizationId + isActive` — a Backstory row is picked up automatically once filters account for user scoping.
- Legacy path: execute-agent binds Backstory MCP via env service account (`backstoryMcpConfigured()` / `BackstoryMcpClient`) with "no tenant isolation".

---

## 1. Data model, seeding, OAuth

### Schema (additive migration)

`McpConnection` gains:
- `userId String?` + relation to `User` — null = org-shared (all existing rows), set = personal connection
- `provider String?` — `'backstory'` is the only value for now; null = user-added generic server
- `lastVerifiedAt DateTime?` — stamped on successful OAuth/refresh for provider rows
- `@@index([organizationId, userId, provider])`

Migration via `prisma migrate deploy` (baselined per prod setup). No backfill needed.

### Seeding

`ensureBackstoryConnection(organizationId, userId)` — idempotent upsert of the per-user row:
- `provider: 'backstory'`, `name: 'Backstory MCP'`, `description: 'Native Backstory tools'`
- `serverUrl` from `BACKSTORY_MCP_URL`, defaulting to `https://mcp.backstory.ai/mcp`
- `authType: 'oauth2'`, `isActive: false` until OAuth completes

Called from `requireAuthContext`'s user-provisioning path, guarded by an in-process per-user memo so the hot path pays one indexed upsert at most once per instance lifetime. Seeding failures log and continue — sign-in is never blocked by the seeder; the next request retries.

### OAuth (reuse, two additions)

- `/api/mcp-connections/oauth/start` accepts `connectionId` (re-authorize an existing row in place — required for the seeded row) and `returnTo` (post-callback redirect, validated as a same-origin path). Scope becomes a parameter defaulting to the current `'claudeai'`; the Backstory flow passes the scope the Backstory MCP auth server expects.
- `/api/mcp-connections/oauth/callback`, when the target row has `provider='backstory'`: set `isActive: true`, stamp `lastVerifiedAt`, redirect to `returnTo` (default `/connect`).
- Ownership check: `connectionId` re-auth requires the row to belong to the caller (same org, and same user when `userId` is set).

---

## 2. The hard gate

### Decision function

`backstoryMcpReady(orgId, userId)` — true when the user's `provider='backstory'` row exists, `isActive`, and `authConfig` holds authcode tokens. Pure evaluator over the row shape (unit-testable) + a thin cached resolver (60s in-process TTL per user). A pre-existing, user-managed active connection to the Backstory server URL (any auth type) also satisfies the gate — users who already configured Backstory MCP never re-configure it — and suppresses per-user seeding.

### API layer (server truth)

`requireAuthContext` runs the check immediately after `assertEntitled`; failure → 403 with code `BACKSTORY_MCP_REQUIRED`. Gating is env-controlled like the entitlement gate (`BACKSTORY_MCP_GATE=on`, on by default in production) so local dev without the MCP server keeps working.

Exempt (via an options flag on the few routes that need it):
- `/api/mcp-connections/oauth/*` (start/callback/discover/test)
- `GET /api/setup/status` (new)
- `/api/peopleai/connect|callback|status` (entitlement step must stay reachable)

Everything else is blocked server-side — the gate cannot be bypassed by skipping the UI.

### Page layer

`SetupGate` client component wrapping the app chrome in `app-shell.tsx` for `APP_PREFIXES` routes (`/dashboard`, `/flows`, `/connections`, `/integrations`, `/templates`):
- On mount: `GET /api/setup/status` → `{ entitled, backstoryConnected }`; skeleton while loading; redirect to `/connect` when `backstoryConnected` is false.
- Any in-app fetch returning 403 `BACKSTORY_MCP_REQUIRED` triggers the same redirect (generalizes the dashboard's existing `ENTITLEMENT_REQUIRED` handling).

`/auth/*`, `/connect`, terms/privacy, and the public landing render bare and ungated, as today.

### /connect becomes a two-step setup

1. **Sales AI entitlement** (existing People.ai CTA) — shown complete when entitled or `salesAiNativeMode()`.
2. **Connect Backstory MCP** — card matching the connections-page style (name, `https://mcp.backstory.ai/mcp`, "OAuth 2.0" badge) with Connect → `/api/mcp-connections/oauth/start?connectionId=<seeded row>&returnTo=/connect`. On return, shows Connected ✓ and auto-forwards to `/dashboard`.

Steps render sequentially; step 2 is available regardless of step 1 so a user can complete them in either order, but the gate requires both (entitlement gate already exists; this spec adds the Backstory requirement).

---

## 3. Consumption, connections UI, errors

### Tool catalog & runtimes

- `loadFlowToolCatalog(organizationId, { userId? })`: filter becomes `organizationId + isActive + (userId: null OR userId: actingUser)`.
- Callers thread the acting user: `GET /api/flows/tool-catalog` (session user), `runFlowExecution` (`job.userId`), execute-agent's McpConnection block (execution user).
- `GET /api/mcp-connections` applies the same filter: users see org-shared servers plus their own Backstory card, never a teammate's.

### Legacy env path retirement

In execute-agent, the env-based `BackstoryMcpClient` binding becomes a fallback: when the acting user has an authorized Backstory row, the row-based `McpClient` path is used (tenant-isolated, per-user tokens). The env service-account path remains for transition, logging a deprecation warning when used.

### Connections UI (provider-managed rows)

`provider='backstory'` cards are locked down:
- No Delete, no Edit; server enforces with 403 `PROVIDER_MANAGED` on PUT/DELETE (except the OAuth callback's own token writes)
- Active toggle replaced by a status pill — **Active** (isActive + fresh tokens) or **Needs authorization**
- **Reauthorize** button → the same OAuth start URL

### Error handling

- OAuth failures: callback redirects to `/connect?error=<reason>`; the step shows the error with a retry CTA.
- Permanent refresh failure (revoked grant): the tool call fails with an actionable message (existing best-effort behavior); the setup-status check reports `backstoryConnected: false` (token freshness considered), so the gate re-engages on next navigation, and the connections card flips to Needs authorization.
- Seeder failures: log + continue; never block sign-in.

### Testing

Existing `node:test` pattern, pure functions first:
- `backstoryMcpReady` evaluator over row shapes (missing row, inactive, tokenless, healthy)
- Seeder upsert idempotency (evaluator for "needs seed" decision + args builder)
- Catalog filter composition (`userId` null/set cases)
- OAuth start param validation (`connectionId` ownership, `returnTo` same-origin)
- CRUD rejection of provider-managed rows
- Setup-status response shape

Verification locally = typecheck + lint + test; the OAuth loop and gate UX validate on a Vercel preview against the real `mcp.backstory.ai`.

## Out of scope

- Migrating existing env-based Backstory service accounts (fallback stays; removal is a later cleanup)
- Per-user scoping for non-Backstory MCP connections (columns support it; no UI for it yet)
- Admin visibility into teammates' connection status
- Multiple providers beyond `'backstory'`
