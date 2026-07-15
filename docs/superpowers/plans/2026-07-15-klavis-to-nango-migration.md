# Klavis → Nango Unification — Implementation Plan

**Goal:** Remove Klavis entirely and provide all agent tools through Nango, so integrations live under ONE provider. Keep every current integration option (the 14 curated providers); the ~90-server Klavis Strata long-tail is dropped (accepted).

**Why safe ordering matters:** Klavis currently supplies agents' tool-calling. If we delete it before the Nango tools exist, agents lose tools mid-migration. So: **build the Nango tool adapters first (both planes coexist, deduped), then remove Klavis last.**

**Verification reality:** the dev server can't run locally (no Supabase) and there are no live Nango credentials here, so adapters are **unit-tested at the proxy-call layer** (given args → assert the exact `{method, endpoint, data}` sent to Nango's injectable proxy) and must be **smoke-verified on a Vercel preview** against real connections before Klavis is deleted.

## Architecture (from the investigation)

- Klavis = hosted MCP runtime: auto-generated tool catalog + execution per provider (14 curated in `provider-capabilities.ts` + ~90 via Strata). Files: `klavis-client.ts`, `server-provisioning.ts`, `strata.ts`, the `MCPAgent` model, the `klavis` tool plane, `/api/mcp/*`, `mcp-integration-cards.tsx`.
- Nango = OAuth storage + raw HTTP proxy. Tool surface today = **3 write adapters** in `src/lib/nango/delivery.ts` (Slack post, Gmail send, Salesforce create), hosted by `loadNangoPlaneGroups` (`tool-planes.ts`), executed at `execute-agent.ts:921`, write-gated by `isWriteProvider` (`registry.ts`).

## Tasks (ordered)

### Task 1 — Nango multi-provider tool framework (per-tool read/write)
- Create `src/lib/nango/provider-tools.ts`: `NangoToolSpec { provider, capability, name, description, inputSchema, isWrite, run(connection, args, proxy) }` + a `NANGO_PROVIDER_TOOLS` registry grouped by provider. Reuse `delivery.ts`'s proxy seam (`NangoProxy`, `defaultProxy`, `withTimeout`) — move/share it.
- Generalize `resolveDeliveryConnection` → `resolveNangoConnection(orgId, providerConfigKeys[], userId)` covering all providers' config keys.
- The existing 3 delivery tools become entries in the new registry (isWrite: true), so `delivery.ts` stays back-compat or is folded in.
- Test: each spec, given sample args, calls the injected proxy with the exact request; read specs are `isWrite:false`.

### Task 2 — Per-tool write classification through the runtime
- `loadNangoPlaneGroups`: emit **one plane group per tool**, each carrying `isWrite: spec.isWrite` (not per-provider). Read tools → `isWrite:false` (no approval gate); write tools → gated as today.
- Reconcile `isWriteProvider('nango:*')`: the approval gate must key off the plane group's `isWrite`, not a blanket `nango:*` = write. Audit/cap-budget follow the same per-tool flag.
- Test: a read tool group is not approval-gated; a write tool group is.

### Task 3 — Author provider tool adapters to parity (the content lift)
Mirror the curated tools in `provider-capabilities.ts`. Per provider, author read + write adapters as Nango proxy calls to the documented REST endpoint, with an arg→request unit test each:
- **github** (REST v3): list_repositories `GET /user/repos`, list_pull_requests `GET /repos/{o}/{r}/pulls`, create_issue `POST /repos/{o}/{r}/issues`, comment `POST /repos/{o}/{r}/issues/{n}/comments`.
- **linear** (GraphQL `POST /graphql`): list_issues, create_issue, update_issue (queries/mutations).
- **jira** (`/rest/api/3`): list_issues `GET /search?jql=`, create_issue `POST /issue`, add_comment `POST /issue/{k}/comment`.
- **asana** (`/api/1.0`): list_tasks, create_task, update_task.
- **notion** (`/v1`): search `POST /search`, create_page `POST /pages`, append `PATCH /blocks/{id}/children`.
- **hubspot** (`/crm/v3`): list/create contacts & deals.
- **confluence** (`/wiki/rest/api`): read/write pages.
- **google_drive** (`/drive/v3`): list/get files.
- **google_sheets** (`/v4/spreadsheets`): read/append values.
- **monday** (GraphQL), **zendesk** (`/api/v2`), **slack** read tools (list_channels/read_messages to add to the existing send), **gmail** (existing send + optional read).
Provider→config-key mapping extends `DELIVERY_PROVIDERS`/`fromNangoProviderKey`.

### Task 4 — Unify the integrations UI under Nango
- `src/app/integrations/page.tsx`: remove the "Agent tools" (Klavis) tab; the Nango grid (now with pagination + AI, already built) becomes the primary "Integrations" view; keep "MCP servers".
- Update header copy (drop "Klavis exposes agent tools").
- The connectable catalog is Nango-dashboard-driven; ensure the 14 providers are enabled there (ops note).

### Task 5 — Remove Klavis (last, once adapters verified on preview)
- Delete: `klavis-client.ts`, `provider-capabilities.ts`, `server-provisioning.ts`, `strata.ts`, `/api/mcp/connections`, `/api/mcp/strata-catalog`, `mcp-integration-cards.tsx`.
- Edit (remove Klavis/Strata branches): `tool-planes.ts`, `execute-agent.ts`, `tool-registry.ts` (drop `'klavis'` provenance), `system-prompt.ts` (drop Strata meta-tool text), `registry.ts` (drop `fromKlavisAgentType`/`KLAVIS_*`), `tool-connection-id.ts` (drop `klavis` plane), `tool-catalog.ts`, `connected.ts`, `org-teardown.ts` (drop Klavis leg), `usage-profile.ts`, `salesai-upsell.ts` (replace `strata:*` keys with `nango:*`), `agent-config-form.tsx` (drop Strata UI), `agent-activity-pane.tsx`, `flow-picker.tsx`, `integration-chip.tsx`.
- Prisma: drop `MCPAgent` model + migration; remove `'MCPAgent'` from `tenant-guard.ts`. Keep `McpConnection` (BYO MCP) but clean Strata rows (serverUrl contains `strata.klavis.ai`).
- Env: remove `KLAVIS_API_KEY` from `.env.example`.
- Tests: update/remove the 9 Klavis/Strata-referencing test files.
- Data: one-off cleanup of `mcp_agents` rows, Strata `mcp_connections`, and `strata:`/`klavis:` keys in agent `integrations` + flow graphs (a backfill script).

### Task 6 — Gates + preview verification
- typecheck, lint, full suite (+ ci_repro DB tests), CI-mode build after each task.
- Before Task 5's deletion: smoke-test the top provider adapters on a Vercel preview with real connections.

## Back-compat notes
- Stored flow graphs / agent `integrations` referencing `klavis:<id>` or `strata:<server>` resolve to no tools after removal — the backfill remaps the migratable ones to `nango:<provider>`; Strata-only ones are dropped with a logged note.
