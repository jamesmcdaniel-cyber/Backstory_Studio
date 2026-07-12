# WS12-B: Auto-Template Usage Substrate + 3-Integration Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sub-project B of the auto-template roadmap (`docs/superpowers/specs/2026-07-11-auto-template-generation-roadmap-design.md` §B): the structured usage signal the generation engine (C) reasons over, plus the ≥3-connected-integrations gate. No template generation here — just the substrate + gate + its read API.

**Architecture:** Two server libs — `countConnectedIntegrations` (reuses the single-sourced "connected" definition from the integrations-available merge) and `buildUsageProfile` (aggregates AuditEvent/WorkflowStep/FlowRunStep into a `UsageProfile`). Pure aggregation extracted so it's node:testable without a DB; thin DB-reading wrappers over it. A read endpoint exposes the count + gate for D's meter.

**Tech Stack:** Prisma (READS only — no schema change in B), Next.js, node:test (+ DB-gated integration tests).

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Gate: `npm run typecheck && npm run lint && npm test` — capture baseline first (concurrent sessions move it; report exact before/after). DB-gated tests run only under `TEST_DATABASE_URL` (CI-mode) — the CI-mode gate on a session-unique DB is the real verifier before push. NEVER run dev/build/prisma.
- **Tenant safety:** every query carries `organizationId`. `buildUsageProfile` is org-level aggregation (all reps' usage informs org templates) — org-scoped, no cross-org read. `countConnectedIntegrations` counts the org+user's connected planes exactly as `/api/integrations/available` defines "connected".
- No graph schema change in B (design §B: "No graph schema change in v1"). No `AgentMemory`/RAG writes.
- Windowing: `buildUsageProfile` is bounded (last N=90 days OR most-recent M=500 audit rows, whichever is tighter) to cap cost — document the exact bound.
- Reuse, don't duplicate: the connected-planes merge lives in `src/app/api/integrations/available/route.ts` (~31-99). If the merge logic is inline in the route, EXTRACT it to a shared server lib (`src/lib/integrations/connected.ts`) and have both the route and `countConnectedIntegrations` import it — single source of "connected".

---

### Task 1: `countConnectedIntegrations` + ≥3 gate + read endpoint

**Files:**
- Read: `src/app/api/integrations/available/route.ts` (the 5-plane merge: mcpConnection, nangoConnection, Klavis/MCPAgent, builtins, Strata — determine what counts as a distinct CONNECTED provider).
- Create/modify: extract the merge to `src/lib/integrations/connected.ts` (`listConnectedProviders(organizationId, userId): Promise<{ key, label, plane }[]>`) if inline; the route imports it.
- Create: `src/lib/integrations/integration-count.ts` — `countConnectedIntegrations(organizationId, userId): Promise<number>` (distinct provider keys, deduped across planes) + `MIN_INTEGRATIONS_FOR_TEMPLATES = 3` + `meetsTemplateGate(count): boolean`.
- Create: `GET /api/integrations/count` (or extend `/api/setup/status`) → `{ connected: number, required: 3, meetsGate: boolean, providers: {key,label}[] }` — org+user scoped. (D's gate meter reads this.)
- Test: `src/lib/integrations/__tests__/integration-count.test.ts`.

**Interfaces (Produces):** `countConnectedIntegrations`, `MIN_INTEGRATIONS_FOR_TEMPLATES`, `meetsTemplateGate`, `listConnectedProviders`. C's `generateTemplateProposals` gate-checks via `countConnectedIntegrations >= MIN_INTEGRATIONS_FOR_TEMPLATES`.

**Steps:**
- [ ] Read the available-integrations route; decide the canonical "distinct connected provider" key (e.g. lowercased provider slug), dedupe across planes (a provider connected via two planes counts once). Document the rule.
- [ ] Extract `listConnectedProviders` if the merge is inline; keep the route's response byte-identical (behavior-preserving extraction).
- [ ] Implement `countConnectedIntegrations` (distinct keys) + gate constants/helper.
- [ ] Endpoint returning the count + meetsGate.
- [ ] Tests: DB-gated fixtures — 0 planes → 0; same provider via 2 planes → 1; 3 distinct providers → 3, meetsGate true; 2 → false. Pure `meetsTemplateGate`/dedupe logic as non-DB unit tests where extractable.
- [ ] Gate + commit `feat(templates): count connected integrations and the 3-integration gate`

---

### Task 2: `buildUsageProfile` — aggregate usage into a structured profile

**Files:**
- Read: `prisma/schema.prisma` (AuditEvent fields — org, action, tool, resourceType/provider, createdAt; WorkflowStep.node `provider.tool`; FlowRunStep provider/tool), and how audit rows are written (grep `recordAudit` call sites) so the aggregation keys off real data.
- Create: `src/lib/templates/usage-profile.ts` — types + a PURE `aggregateUsage(rows: UsageRow[]): UsageProfile` + a DB wrapper `buildUsageProfile(organizationId): Promise<UsageProfile>`.
- Test: `src/lib/templates/__tests__/usage-profile.test.ts` (pure aggregation) + a DB-gated integration test.

**Interfaces (Produces):**
```ts
export type UsageRow = { provider: string, tool: string, runId: string | null, at: string }
export type UsageProfile = {
  providers: { provider: string, calls: number }[]        // desc by calls
  topTools: { provider: string, tool: string, calls: number }[]  // desc, capped (e.g. 25)
  coOccurrence: { providers: string[], runs: number }[]   // provider SETS used together in a run/flow, desc
  sequences: { steps: string[], count: number }[]         // recurring provider->provider->... chains, desc, capped
  runCount: number
  windowDays: number
}
export function aggregateUsage(rows: UsageRow[]): UsageProfile
export function buildUsageProfile(organizationId: string): Promise<UsageProfile>
```

**Semantics (pure `aggregateUsage`):**
- `providers`: count rows per provider.
- `topTools`: count per (provider, tool), keep top 25.
- `coOccurrence`: group rows by `runId` (drop null-run rows for co-occurrence); for each run, the SET of distinct providers used; count how many runs share each set (size ≥ 2 sets only); desc, cap 25.
- `sequences`: within each run ordered by `at`, the ordered list of DISTINCT-adjacent providers (collapse consecutive same-provider); count identical ≥2-length sequences across runs; desc, cap 25.
- Deterministic tie-break: secondary sort by the joined key string so output is stable (tests depend on it).

**`buildUsageProfile` (DB wrapper):** query AuditEvent for the org within the window (last 90 days AND at most the most-recent 500 rows), map to `UsageRow` (provider from resourceType/tool split — match how recordAudit stores it), set `runCount`/`windowDays`, call `aggregateUsage`. Org-scoped. If audit coverage is thin, ALSO fold in FlowRunStep/WorkflowStep provider.tool rows for the org (same window) so few-run orgs still get signal — document which tables feed it.

**Steps:**
- [ ] Read schema + recordAudit call sites to nail the provider/tool extraction.
- [ ] Failing pure tests (RED): co-occurrence set counting; sequence collapse + counting; top-tools cap; empty rows → empty profile; deterministic ordering.
- [ ] Implement `aggregateUsage` (pure) → GREEN; then the DB wrapper + a DB-gated test on seeded audit rows.
- [ ] Full gate (report exact). Commit `feat(templates): build a usage profile from integration activity`

---

### Task 3: Enrichment + finalize

**Files:** `src/lib/templates/usage-profile.ts` (enrichment), read `PROVIDER_CAPABILITIES` / Klavis tool lists + People.ai theme source.

**Work:**
- Enrich `UsageProfile` with `capabilities: { provider, capabilities: string[] }[]` for CONNECTED providers (from `PROVIDER_CAPABILITIES` and, where available, Klavis tool lists) — so the profile is meaningful even for an org with few runs (a freshly-connected provider contributes its capability list even with zero calls).
- When a People.ai connection exists, add high-level `themes: string[]` (account/opportunity themes) via the existing RAG/People.ai theme source (reuse `retrieveContext` or the Sales-AI entity summaries — read what's available; keep it a bounded, org-scoped read; do NOT block if People.ai absent).
- Tests: enrichment adds capabilities for a connected provider with zero calls; themes populated only when People.ai present (mock/skip if DB-gated).

**Steps:**
- [ ] Implement enrichment (both are additive, non-blocking, degrade cleanly when a source is absent).
- [ ] Full gate.
- [ ] Whole-sub-project review (emphasis: tenant scoping on every read; windowing bound enforced; extraction of the connected-planes merge is behavior-preserving; no PII beyond provider/tool/theme strings leaks into the profile). Fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB; commit `feat(templates): enrich usage profile with capabilities and themes`; push; confirm CI green.
