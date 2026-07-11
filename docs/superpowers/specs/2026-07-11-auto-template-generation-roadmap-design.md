# Auto-Template Generation — Roadmap Design (Umbrella Spec)

**Status:** Design (2026-07-11)
**Shape:** Umbrella roadmap over 4 sequenced sub-projects (A→B→C→D). Each sub-project gets its OWN detailed spec + implementation plan + subagent-driven build; this document fixes the shared architecture, data model, and interfaces so the four compose cleanly.

## Goal

Turn the "Your data takes shape" promise into a real system: after a business connects its tools, the platform learns how that business actually uses them (from integration history + assistant/flow/agent runs, **before the user builds anything**), then **proposes** agent templates for the recurring cross-tool use-cases it detects, and proposes improvements to the flows/assistants they already have. Proposed templates live in a **review queue**; on approval they enter an **org-scoped catalogue that is prioritized above the shared global library**.

## The pictured onboarding this serves

Connect your tools → **Your data takes shape** → Your AI goes live. This feature is the middle step made real, plus the catalogue the third step deploys from.

## Product decisions (locked)

- **Autonomy = suggestion-queue.** The AI never silently publishes to the catalogue. It writes **template proposals** to a review inbox; the user approves/edits/dismisses; only approved proposals become catalogue templates. (User-chosen over auto-publish.)
- **Gate = 3+ connected integrations** before any generation runs — enough cross-tool context for correlation, not generic boilerplate.
- **Catalogue priority:** the org's own templates (especially AI-generated-from-their-usage) rank **above** the shared global community library. The global library stays accessible.
- **Build = subagent-driven**, sub-project by sub-project, in order.

## Prerequisites (already shipped, 2026-07)

- Graph-RAG per-rep isolation (`nodeVisibleTo`, `ownerUserId`/`visibility` on nodes).
- Agent-memory owner/visibility threading (private agents' learned facts stay private).
- The RAG eval harness (a measurement backbone we can extend if generation quality needs proving).

## Reality corrections from the current-state audit

- **"Auto-create template" does not exist yet** — it is net-new. What feels broken today is the catalogue *read*: `GET /api/agent-templates` uses `systemPrisma` (tenant-guard bypass) and returns **every org's** stored templates, `updatedAt desc`, with no org-first ordering. Writes (POST/PUT/DELETE) are already org-locked.
- **`AgentTemplate`** (`prisma/schema.prisma:479-499`) has `userId` + `organizationId` but **no** `visibility`/`source` column; category/tags/instructions live in the `configuration` JSON.
- **No integration-count helper and no ≥N gate** exist. Connections live across 5 plane tables (Klavis `MCPAgent`, `PeopleAiConnection`, `McpConnection`, `NangoConnection`, `IntegrationSecret`); `GET /api/integrations/available` already merges them into `connected`-flagged chips.
- **Usage is recorded but never aggregated.** Best source: `AuditEvent` (`resourceType`=provider, `tool`, indexed by org); also `WorkflowStep.node` (`provider.tool`), `WorkflowEvent` (`tool.*`), `FlowRunStep`.
- **Graph-RAG has no tool/integration nodes and no run→tool edges** (`toolSummaries` is never populated on run nodes). Cross-tool co-occurrence must be mined from the audit/step logs in v1.
- **`Pipedream` is conceptual only** — no model/client/table. Do not depend on it.
- The `agents/draft` route (`DRAFT_SCHEMA` → `generateStructured` → row) is the exact pattern the generator mirrors.

---

## Shared data model (introduced across A and C)

Two additive migrations, no destructive changes:

**A — extend `AgentTemplate`:**
- `source String @default("user")` — one of `user` | `ai_generated`. (Built-in templates remain static code, not rows.)
- `visibility String @default("org")` — one of `org` | `global`. Existing rows are backfilled to `global` (preserve today's community-library behavior). New user-created default `org`.
- Index: `@@index([organizationId, visibility])`.

**C — new `TemplateProposal` model** (the review queue; a proposal is NOT yet a template):
- `id`, `organizationId @db.Uuid`, `userId` (the rep the proposal is for; nullable for org-wide), `title`, `rationale @db.Text` (why this was proposed, grounded in the usage evidence), `kind String` (`agent_template` | `flow_template` | `process_improvement`), `configuration Json` (the proposed `AgentTemplate.configuration` payload, or the improvement target+diff for `process_improvement`), `status String @default("open")` (`open` | `accepted` | `dismissed`), `sourceEvidence Json` (the usage signals that justified it — provider set, co-occurrence, run refs), `createdTemplateId String?` (set when accepted → the resulting `AgentTemplate.id`), timestamps.
- Cascades on org delete (WS-R4 completeness); pruned by retention parity if desired (deferred).
- Indexed `@@index([organizationId, status])`.

Approval flow: accepting an `agent_template`/`flow_template` proposal calls A's `createTemplate(...)` with `source: 'ai_generated', visibility: 'org'`, stamps `createdTemplateId`, flips `status: 'accepted'`. Accepting a `process_improvement` proposal opens the target flow/agent editor prefilled (no template created).

---

## Sub-project A — Catalogue foundation (org-scoped, prioritized, source-tagged)

**Goal:** make the catalogue org-aware and prioritized, and give C a clean write path.

**Scope:**
- Migration: add `source` + `visibility` to `AgentTemplate`; backfill existing → `global`.
- Rewrite `GET /api/agent-templates` scoping: return the org's own templates (any visibility) ∪ `visibility='global'` from other orgs ∪ built-ins. Order: **org-owned first (ai_generated above user-created), then global, then built-ins** — or a documented ranking that puts the org's own catalogue on top. Keep `systemPrisma` ONLY for the explicit `visibility='global'` cross-org slice, with a justification comment; the org's own slice goes through the tenant-guarded client.
- POST default `visibility: 'org'` (was implicitly global). A "Publish to community" action flips a template to `global`.
- `createTemplate(params)` helper (server lib) that both the POST route and C's approval path call — single writer, sets `source`/`visibility`/org/user.

**Interface out:** `createTemplate(...) -> AgentTemplate`; the catalogue read returns templates tagged with `source`, `visibility`, and `mine`.

**Testing:** route-scoping unit tests (org sees own + global, not other orgs' `org`-visibility rows; ordering puts own first); `createTemplate` sets the right fields; migration backfill test.

---

## Sub-project B — Usage substrate + 3-integration gate

**Goal:** the structured signal C reasons over, plus the gate.

**Scope:**
- `countConnectedIntegrations(organizationId, userId)` — counts distinct connected providers across the 5 plane tables (reuse the `/api/integrations/available` merge so the definition of "connected" stays single-sourced). Returns a number; `>= 3` is the gate.
- `buildUsageProfile(organizationId)` — aggregates `AuditEvent` (+ `WorkflowStep`/`FlowRunStep` as needed) into a structured `UsageProfile`: per-provider call counts, most-frequent tools, **recurring tool sequences**, and **cross-tool co-occurrence within a run/flow** (which providers get used together). No graph schema change in v1. Bounded/windowed (last N days or M runs) to cap cost.
- Enrich with agent-independent context: connected providers' capability lists (`PROVIDER_CAPABILITIES`, Klavis tool lists) and, when a People.ai connection exists, high-level account/opportunity themes — so the profile is meaningful even with few runs.

**Interface out:** `UsageProfile` (JSON: providers, top tools, co-occurrence pairs/sets, recent themes, run/flow counts) + `integrationsConnected: number`.

**Testing:** `countConnectedIntegrations` across mixed plane fixtures (dedupe, connected-only); `buildUsageProfile` co-occurrence + frequency correctness on seeded audit/step rows (DB-gated).

---

## Sub-project C — Generation engine (proposals, not publishes)

**Goal:** gated org-level job that turns the usage profile into reviewable proposals.

**Scope:**
- New BullMQ queue `TEMPLATE_GENERATION` + worker spec (mirror the existing `createQueue` + `runtime.ts` worker-spec pattern). Enqueued (a) when the gate first clears (from the connect flow) and (b) on a daily org sweep (reuse the cron pattern), debounced per org.
- `generateTemplateProposals(organizationId)`:
  1. Gate-check `countConnectedIntegrations >= 3`; else no-op (record why).
  2. Assemble context: `buildUsageProfile` + graph-RAG correlated context (`retrieveContext` themes) + existing catalogue (to dedupe) + existing flows/agents (to target improvements).
  3. `generateStructured` (mirroring `DRAFT_SCHEMA`) → a set of proposed templates (name, type/category, instructions, integrations, schedule, exampleOutput) each with a `rationale` + `sourceEvidence`, and a set of `process_improvement` proposals for existing flows/assistants.
  4. Dedupe against the catalogue + already-open proposals; write `TemplateProposal` rows (`status: 'open'`).
- Approval endpoints: `POST /api/template-proposals/:id/accept` (→ `createTemplate` for template kinds, or open editor for improvements; stamp `createdTemplateId`), `POST .../dismiss`. `GET /api/template-proposals` lists open proposals for the org/user.

**Interface out:** `TemplateProposal` rows + the accept/dismiss/list API that D renders.

**Testing:** gate no-op below 3; generation is schema-valid + deduped (mock `generateStructured`); accept promotes to an `ai_generated`/`org` template via `createTemplate` and stamps `createdTemplateId`; dismiss is terminal. Optionally extend the RAG eval to score proposal groundedness (deferred).

---

## Sub-project D — Onboarding UX (the pictured 3 steps)

**Goal:** the "Connect → Data takes shape → AI goes live" experience, with the proposal review inbox as the middle step.

**Scope:**
- Extend `/connect` (today a 2-step entitlement+MCP gate) into 3 stages. **Connect your tools** shows connected-integration progress toward the 3-gate. **Your data takes shape** shows learning progress (usage profile built, generation running) and the **proposal review inbox** — accept/edit/dismiss `TemplateProposal`s, including process-improvement proposals for existing flows/assistants. **Your AI goes live** deploys from the now-prioritized catalogue (org's own first).
- Trigger generation when the 3rd integration connects; poll/refresh proposals as they land.

**Interface in:** A's prioritized catalogue read, C's proposal list + accept/dismiss API, B's `integrationsConnected` for the gate meter.

**Testing:** component tests for the review inbox (render proposals, accept→removed+catalogue entry appears, dismiss→removed) using the existing jsdom/@testing-library harness; gate-meter logic unit test.

---

## Non-goals (deferred, may become their own specs)

- **Graph-RAG tool/integration nodes + run→tool edges** (populating `toolSummaries`, a `uses_tool` relation). v1 mines the audit/step logs directly; graph enrichment is a later quality upgrade.
- **Flow-template generation depth** — v1 focuses on agent-template proposals + process-improvement proposals; full flow-graph generation (via the flow copilot generator) is a fast-follow within C or a later sub-project.
- **Pipedream** — not implemented; out of scope.
- **Auto-publish / fully-autonomous modes** — explicitly rejected in favor of the suggestion queue.
- **Cross-org template recommendations** ("orgs like yours used…") — future.

## Sequencing & why

A → B → C → D. A is the foundation every later piece writes into and is independently shippable (the scoping fix). B is the pure substrate C consumes. C is the heart and depends on both. D surfaces C. Each sub-project is CI-verifiable on its own; the umbrella exists so their data model and interfaces are decided once, here.

## Constraints

- Code style: single quotes, no semicolons, 2-space indent.
- No raw `{{token}}` syntax in any user-facing UI (plain-English chips + explicit validation).
- Tenant safety: every new query carries `organizationId`; the only cross-org read (the `global` catalogue slice) uses `systemPrisma` with an explicit `visibility='global'` filter and a justification comment.
- Migrations are additive (new columns default-valued, new model) — no destructive schema change; production schema sync via `prisma migrate deploy`.
- Reuse existing seams: `generateStructured`/`DRAFT_SCHEMA` for generation, `createQueue`+worker-spec or `/api/cron/*` for the job, `/api/integrations/available` for the connected-set definition, the component-test harness for UI.
