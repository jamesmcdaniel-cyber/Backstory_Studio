# WS9: Flow Execution & Connectivity Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 9: flows execute with the same tool access, credential wiring, input memory, live visibility, and robustness as standalone agents.

**Architecture:** Six mostly-independent workstreams sharing one theme — reuse the AGENT runtime's existing machinery (tool registry, executions event feed, connection token refresh, memory) at the flow layer instead of flow-local reimplementations. Investigation findings are in the ledger (`.superpowers/sdd/progress.md`, "INVESTIGATION" block) — implementers get exact file:line pointers per task.

**Tech Stack:** Prisma (no new tables; one nullable column addition allowed if needed — prefer none), Next.js, node:test.

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Baseline at plan time: 405 pass / 6 skip, 4 pre-existing lint warnings. Never run dev/build/prisma locally; CI-mode gate before push. Migrations, if any, are hand-authored SQL in `prisma/migrations/<timestamp>_name/migration.sql` + `npx prisma generate`.
- Secrets discipline: connection tokens are NEVER stored in graph JSON, FlowRunStep rows, logs, or client payloads. Authorization headers are injected server-side at fetch time only.
- No user-visible raw enums or `{{` in new copy.
- Every task ends at the standard gate; tasks touching cron/scheduling or DB-backed paths note it so the final CI-mode gate is understood as the real verifier.

---

### Task 1: Connector catalog parity (tool planes)

**Files:**
- Modify: `src/lib/flows/tool-catalog.ts` (currently queries `mcpConnection` ONLY — root cause of the picker gap)
- Read for grounding: `src/features/agents/tool-registry.ts` (`buildToolRegistry`, `ToolProvenance = 'people_ai' | 'klavis' | 'mcp' | 'native' | 'nango'`), `src/features/agents/execute-agent.ts` (~lines 822-825: how the agent loads its tool groups per run — find the functions that produce each plane's `RegistryToolInput[]` and REUSE them), `src/lib/connectors/registry.ts`
- Modify: `src/features/flows/execute-flow.ts` / wherever the tool-step `runAction` adapter dispatches tool calls (find it; it must route through the same per-plane executors the agent uses, including the approval gate for write tools — grep `requiresApproval` / `createApproval` in execute-agent for the gate pattern)
- Modify if needed: `src/components/flows/flow-picker.tsx` (connector grouping — should mostly light up automatically once the catalog returns all planes; verify grouping/icons via `src/lib/connectors/registry.ts` helpers)

**Interfaces:**
- `loadFlowToolCatalog` return shape is UNCHANGED (`FlowToolCatalogConnection[] = { id, name, tools[] }`) — new planes appear as additional "connections" (e.g. Nango connection rows, Klavis-provisioned servers, People.ai) with stable ids the tool node stores in `connectionId`. Prefix synthetic ids by plane (e.g. `nango:<connectionId>`, `plane:people_ai`) so execution can route; document the id scheme in the file header.
- Tool-step execution: given `connectionId` + `toolName` + args, dispatch to the correct plane executor with the SAME approval semantics as agent tool calls.

**Steps:**
- [ ] Read the agent's tool-group loading end-to-end; extract/reuse (do NOT duplicate) the per-plane loaders so catalog and execution share them.
- [ ] Extend `loadFlowToolCatalog` to all planes; verify the picker groups them (Built-in vs Connected chips) sensibly.
- [ ] Route tool-step execution through the shared dispatch incl. approval gate (a write tool in a flow pauses the run `waiting` with kind 'approval' — the WS8 machinery already surfaces that).
- [ ] Tests: catalog id-scheme round-trip + dispatch routing as pure-logic node:tests where extractable.
- [ ] Gate + commit `feat(flows): tool catalog and execution draw from all agent tool planes`

---

### Task 2: HTTP credential wiring

**Files:**
- Modify: `src/lib/flows/graph.ts` (http node: add optional `connectionId?: string` — zod `.optional()`, no migration needed)
- Modify: the http executor (`src/features/flows/http.ts` or wherever `jsonBody`/fetch live — find it), `src/features/flows/execute-flow.ts` runAction path
- Modify: `src/components/flows/step-drawer.tsx` + `src/components/flows/step-card.tsx` http editors (connection select fed from the flow tool catalog / connections list; label "Authenticate with (optional)")
- Read: `ensureFreshConnectionToken` usage in `src/lib/flows/tool-catalog.ts` / execute-agent — reuse it.

**Steps:**
- [ ] Schema + editors (drawer AND expanded card — both have http panels; plain select, non-token field, block-sentinel on focus like other selects... selects don't need the sentinel; match neighboring selects).
- [ ] Executor: when `connectionId` set, resolve the connection (org-scoped!), `ensureFreshConnectionToken`, inject `Authorization: Bearer <token>` UNLESS the user already set an Authorization header (user's explicit header wins). Never log the token; redact Authorization in any persisted request/step detail (check what FlowRunStep.input stores for http steps).
- [ ] Validation: `validateFlowGraph` warns when `connectionId` references a connection missing from the catalog context.
- [ ] Tests: header-injection precedence + redaction as pure functions.
- [ ] Gate + commit `feat(flows): http steps authenticate with a connection — tokens injected at fetch, never stored`

---

### Task 3: Input memory & resume input integrity

**Files:**
- Modify: `src/features/flows/execute-flow.ts` (resume input reload; last-successful-input fallback), `src/app/api/cron/dispatch/route.ts` (scheduled fallback), `src/app/flows/[id]/page.tsx` + `src/components/flows/test-input-panel.tsx` (prefill)

**Behavior (from spec):**
- Resume: when resuming a waiting run, reload `run.input` from the FlowRun row and use it as the interpreter input (today it re-derives as `''` — `Run input` tokens resolve empty downstream after a resume).
- Fallback: manual or scheduled runs whose required trigger inputs are missing (the `FLOW_INPUT_ERROR` path / `missingRequiredInputFields`) fall back to the most recent SUCCESSFUL run's input for the same flow — but ONLY if the graph hasn't changed since that run (compare the stored `graphSnapshot`'s trigger input fields, or simpler: compare `flow.updatedAt < lastSuccess.startedAt`; pick the simplest correct signal and document it). When fallback engages, record it on the run (`trigger: { ...— add a `reusedInput: true` marker inside the existing trigger Json }`) and the run panel shows "Using the input from the last successful run."
- Prefill: builder test input initializes from the last successful run's input when the local state is empty (fetch exists — runs API `latest`/full mode carries `input`).

**Steps:**
- [ ] Resume input reload + node:test where the interpreter harness allows (there are execute-flow-adjacent tests? if not, pure-helper extraction for the fallback decision: `shouldReuseInput(flowUpdatedAt, lastSuccess)` + tests).
- [ ] Fallback in both manual execute route path and cron dispatch; marker + panel copy.
- [ ] Prefill in the builder (only when the user hasn't typed — don't clobber).
- [ ] Gate + commit `feat(flows): flows remember their input — resume integrity, last-successful fallback, builder prefill`

---

### Task 4: Live step visibility

**Files:**
- Modify: `src/features/flows/execute-flow.ts` (write `agentExecutionId` at step START — runAgentExecution returns the id only at the end today; check whether it accepts a pre-created execution or emits the id early; if not, the cheapest correct path is: runAgentExecution already creates the execution row immediately — add an optional `onExecutionCreated?: (id: string) => void` callback to its options, called right after creation, and the flow adapter updates the step row from it)
- Modify: `src/app/api/flows/[id]/runs/route.ts` (return `agentExecutionId` on full-mode steps)
- Modify: `src/components/flows/run-panel.tsx` (running/waiting agent step with an executionId: poll `GET /api/workflows/executions?executionId=` and render a compact live event feed — reuse the event-shaping logic from `src/components/agent-activity-pane.tsx` (~lines 561-593) by EXTRACTING the pure event→feed mapping to a shared lib if it isn't already; do not fork it)

**Steps:**
- [ ] Execution-id-at-start plumbing (callback), step row update, API exposure.
- [ ] Panel feed (poll every 2s while the step is running/waiting AND the panel is open; show last ~6 events: thinking/plan/tool names in plain english; replace the fake TypewriterStatus for agent steps that have an executionId — keep it for non-agent steps).
- [ ] Gate + commit `feat(flows): watch what an agent step is actually doing — live process feed in the runs panel`

---

### Task 5: Robustness — timeout race + reaper + stale-waiting scheduling

**Files:**
- Modify: `src/features/flows/interpret.ts` (~lines 124-134: the retry `Promise.race` that abandons a live execution and re-runs CONCURRENTLY), `src/features/flows/execute-flow.ts`, `src/app/api/cron/dispatch/route.ts`

**Behavior:**
- Timeout race: when a step times out, do NOT start a second concurrent execution while the first may still be live. Correct minimal semantics: on timeout, mark the step failed with 'Timed out after Ns.' and DON'T retry agent steps via the generic retry loop (retries stay for hard errors of idempotent-ish steps: http GET etc. — inspect what `retries` currently covers and scope: agent steps get `retries: 0` unless explicitly configured). Document the decision in the code.
- Reaper: in the cron dispatch tick, fail FlowRuns stuck `running` with `startedAt` older than the execution budget (1200s + slack → 30 min): `status: 'failed', error: 'The run was interrupted and timed out.'` — mirror the existing agent-execution reaper (~cron/dispatch/route.ts:74-86).
- Stale waiting: the overlap guard skips scheduling while the latest run is running OR waiting; change: `waiting` runs older than 24h no longer block (the schedule proceeds; the old run stays answerable). Log/skip-note shape follows the existing dispatcher patterns.

**Steps:**
- [ ] Each behavior + targeted node:tests for pure parts (reaper cutoff decision, overlap-guard decision — extract as pure helpers if inline today).
- [ ] Gate + commit `fix(flows): no duplicate executions on timeout, stuck runs reaped, stale waits stop blocking schedules`

---

### Task 6: Cross-path reply coherence

**Files:**
- Modify: `src/app/api/executions/[id]/reply/route.ts` (agent-pane reply endpoint)
- Read: `src/features/flows/execute-flow.ts` resume path, WS8's execute-route hardening.

**Behavior:** when the execution being replied to is referenced by a `FlowRunStep` whose run is `waiting` (`prisma.flowRunStep.findFirst({ where: { agentExecutionId: id }, include: { run: true }, orderBy: { startedAt: 'desc' } })`), do NOT resume the bare agent execution — instead call `runFlowExecution({ flowId: run.flowId, organizationId, userId, flowRunId: run.id, reply })` so the FLOW resumes (which itself resumes the agent with the reply — the whole point). Org-scope everything. If the run is not waiting (already resumed elsewhere), fall through to the existing behavior/error.

**Steps:**
- [ ] Implement + verify no double-resume with the WS8 atomic claim (the flow path claims; a concurrent direct agent reply loses cleanly).
- [ ] Gate + commit `fix(agents): replying to a flow-owned agent execution resumes the flow, not just the agent`

---

### Task 7: Final verification + whole-workstream review + push

- [ ] Full gate; opus whole-review on the review package (emphasis: secrets discipline in Task 2, approval-gate parity in Task 1, no scheduling regressions in Task 5); fix Critical/Important.
- [ ] CI-mode gate (ci_repro + build) then push; confirm CI green.
