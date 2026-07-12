# WS12-C: Auto-Template Generation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sub-project C (`docs/superpowers/specs/2026-07-11-auto-template-generation-roadmap-design.md` §C): a gated org-level job that turns B's usage profile + graph-RAG context into REVIEWABLE `TemplateProposal`s (never auto-published), with accept/dismiss/list APIs. Depends on B (`countConnectedIntegrations`, `buildUsageProfile`) and A (`createTemplate`, the prioritized catalogue).

**Architecture:** New additive `TemplateProposal` model (review queue). A pure proposal-assembly + `generateStructured` call in a server lib; dedupe against the catalogue + open proposals. A gated BullMQ `TEMPLATE_GENERATION` worker enqueued (a) when the 3-gate first clears and (b) by a daily org sweep (debounced). Accept promotes a template-kind proposal via A's `createTemplate(source:'ai_generated', visibility:'org')`; a `process_improvement` proposal opens the target editor prefilled (no template created).

**Tech Stack:** Prisma (ONE additive model + hand-authored SQL migration), BullMQ, generateStructured, node:test (+ DB-gated).

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Gate: `npm run typecheck && npm run lint && npm test` — capture baseline first, report exact. DB-gated tests + migration validity are verified by the CI-mode gate on a session-unique DB (the real verifier). NEVER run dev/build/prisma migrate/db push. After a schema.prisma edit, run `npx prisma generate` (codegen only, no DB).
- **Migration discipline:** the `TemplateProposal` model is a hand-authored SQL migration in `prisma/migrations/<timestamp>_template_proposal/migration.sql` + the schema.prisma model + `npx prisma generate`. Additive only (new table). CI's `migrations` job proves it applies from zero with no drift — treat that as the gate.
- **Suggestion queue, NOT auto-publish** (design non-goal): generation writes `status:'open'` proposals; nothing becomes a live template without an explicit accept.
- Tenant safety: every query carries `organizationId`. `saveAgentMemory`/RAG callers with private-agent context MUST pass owner+visibility (the fail-open `'shared'` trap) — C does NOT write AgentMemory, but if generation reads RAG it passes the org's viewer scope.
- Cost bounds: `generateStructured` maxTokens bounded; generation debounced per org (don't regenerate within N hours); dedupe prevents proposal spam.

---

### Task 1: `TemplateProposal` model + migration + CRUD lib

**Files:** `prisma/schema.prisma` (model), `prisma/migrations/<ts>_template_proposal/migration.sql`, `src/lib/templates/proposals.ts` (typed CRUD helpers), tests.

**Design (Produces):** model per design §data-model — `id`, `organizationId @db.Uuid`, `userId String?`, `title`, `rationale @db.Text`, `kind String` (agent_template|flow_template|process_improvement), `configuration Json`, `status String @default("open")` (open|accepted|dismissed), `sourceEvidence Json`, `createdTemplateId String?`, `createdAt`/`updatedAt`. `@@index([organizationId, status])`. Cascade on org delete (match sibling models' onDelete). Add to `ORG_SCOPED_MODELS` in `src/lib/tenant-guard.ts` (it's org-scoped).
- `proposals.ts`: `listOpenProposals(orgId, userId?)`, `getProposal(id, orgId)`, `writeProposals(orgId, rows)`, `markAccepted(id, orgId, createdTemplateId?)`, `markDismissed(id, orgId)`. All org-scoped.

**Steps:**
- [ ] schema.prisma model + hand-authored migration SQL (mirror an existing additive migration's format exactly — column types, defaults, index, FK cascade) + `npx prisma generate`.
- [ ] Add to tenant-guard ORG_SCOPED_MODELS.
- [ ] `proposals.ts` CRUD (org-scoped).
- [ ] DB-gated tests: write→list open; markAccepted stamps createdTemplateId + status; markDismissed terminal; org isolation (another org can't read).
- [ ] Gate + commit `feat(templates): TemplateProposal model — the AI proposal review queue`

---

### Task 2: `generateTemplateProposals` — the generation core

**Files:** `src/lib/templates/generate-proposals.ts` + tests. Read: `src/app/api/agents/draft/route.ts` (the DRAFT_SCHEMA → generateStructured → row pattern to MIRROR), `src/lib/llm/model-runner.ts` (generateStructured + strictifySchema — free-form objects need the string-wrapper pattern), `src/lib/rag/retrieve.ts` (`retrieveContext` for correlated themes), A's `src/lib/templates/catalogue.ts` (existing catalogue for dedupe), B's `buildUsageProfile`/`countConnectedIntegrations`.

**Design (Produces):** `generateTemplateProposals(organizationId): Promise<{ written: number, skipped: string | null }>`:
1. Gate: `countConnectedIntegrations(org, <org owner/any user?>) >= 3` — else return `{ written: 0, skipped: 'gate' }` (record why, no throw). (Decide the userId for the gate — org-level: count the org's connected planes; document.)
2. Assemble context: `buildUsageProfile(org)` + `retrieveContext` themes (org-scoped viewer) + existing catalogue rows (to dedupe) + existing flows/agents (to target `process_improvement`).
3. `generateStructured` with a strict schema (mirror DRAFT_SCHEMA; free-form config via the string-wrapper pattern) → proposals: template proposals `{ title, kind, category/type, instructions, integrations, schedule?, exampleOutput, rationale, sourceEvidence }` + process_improvement proposals `{ title, kind:'process_improvement', targetId, targetType (flow|agent), rationale, configuration: {improvement diff/notes}, sourceEvidence }`.
4. Dedupe: drop proposals whose title/intent matches an existing catalogue template OR an already-open proposal (case-insensitive title + a cheap intent key). Cap the batch (e.g. ≤8).
5. `writeProposals(org, deduped)`.

**Steps:**
- [ ] Read the draft route + model-runner strictify + retrieveContext + catalogue.
- [ ] Failing tests (RED): gate below 3 → `{written:0, skipped:'gate'}`, no generateStructured call (inject a mock); generation with a mocked generateStructured returns schema-valid proposals; dedupe drops a proposal matching an existing catalogue title and an already-open proposal; batch cap enforced; sourceEvidence carries the usage signals. (Mock generateStructured + the DB reads via injected deps so the core is unit-testable; a thin DB-gated end-to-end test optional.)
- [ ] Implement → GREEN → full gate.
- [ ] Commit `feat(templates): generate grounded template proposals from usage + graph-RAG`

---

### Task 3: `TEMPLATE_GENERATION` queue + worker + triggers

**Files:** `src/lib/queue/config.ts` (QUEUE_NAMES), `src/lib/workers/runtime.ts` (worker spec — mirror the flow/agent worker registration), a job type + `dispatchTemplateGeneration(orgId)`, the cron dispatch route (`src/app/api/cron/dispatch/route.ts` — add a debounced daily org sweep), and the gate-first-clears enqueue (from the connect flow / when the 3rd integration connects — a hook B/D can call).

**Design:** enqueue `generateTemplateProposals(org)` (a) when the gate first clears (debounce: only if no open proposals + no recent generation), (b) daily per org via cron (debounced — skip if generated within 20h or no new usage). Worker runs the Task-2 core. Dead-letter parity with the flow queue's status-guarded pattern (don't clobber unrelated state). Inline-execution mode support (mirror how agent/flow jobs run inline when workers disabled).

**Steps:**
- [ ] Queue name + worker spec + job type + dispatch helper (mirror existing queues exactly).
- [ ] Cron daily debounced org sweep + gate-first-clears enqueue hook.
- [ ] Tests: debounce decision (pure helper `shouldGenerateNow(lastGeneratedAt, hasOpenProposals, now)`); the enqueue path is glue (note for CI-mode).
- [ ] Gate + commit `feat(templates): gated generation job — enqueue on gate-clear and a daily sweep`

---

### Task 4: Accept / dismiss / list API

**Files:** `src/app/api/template-proposals/route.ts` (GET list), `src/app/api/template-proposals/[id]/accept/route.ts`, `.../[id]/dismiss/route.ts`. Read A's `createTemplate`.

**Design:**
- `GET /api/template-proposals` → open proposals for the org (+ the user's own), newest-first. Add a route-smoke case (the coverage guard requires it).
- `POST .../[id]/accept`: for `agent_template`/`flow_template` → `createTemplate({ ...configuration, source:'ai_generated', visibility:'org', organizationId, userId })`, stamp `createdTemplateId`, `status:'accepted'`, return the new template id. For `process_improvement` → return `{ open: { targetType, targetId } }` (the client opens the flow/agent editor prefilled), mark `status:'accepted'` (no template created). Org-scoped; idempotent (already-accepted → return current state).
- `POST .../[id]/dismiss`: `status:'dismissed'` (terminal, idempotent). Org-scoped.

**Steps:**
- [ ] Implement the three routes + route-smoke case for the GET.
- [ ] Tests (DB-gated): accept agent_template → an `ai_generated`/`org` AgentTemplate exists via createTemplate + createdTemplateId stamped; accept process_improvement → no template, returns the target, status accepted; dismiss terminal; cross-org accept 404s.
- [ ] Gate + commit `feat(templates): accept, dismiss, and list AI template proposals`

---

### Task 5: Finalize

- [ ] Full local gate; whole-sub-project review (emphasis: migration applies from zero + no drift; tenant scoping on every proposal query; accept can't create a global/other-org template; generation is gated + deduped + cost-bounded; no auto-publish path exists). Fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB (validates the migration + DB-gated tests) + build; push; confirm CI green (the `migrations` job especially).
