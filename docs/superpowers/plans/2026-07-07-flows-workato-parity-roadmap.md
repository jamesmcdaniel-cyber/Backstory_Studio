# Flows → Workato Builder Parity — Gap Analysis & Roadmap

**Date:** 2026-07-07
**Method:** Multi-agent audit — 3 readers mapped the real code, 12 dimension analyses compared against the Workato builder, gaps verified against source. (The auto-synthesis pass was cut off by a session limit; this roadmap was synthesized from the completed per-dimension results, which the code author reviewed.)

## Headline

**Overall parity ≈ 20%.** The engine *core* we shipped is solid and well-tested — deterministic interpretation, output threading, conditions, loop fan-out, parallel, guards, ask-user pause. But Workato's builder is a mature operability + data-mapping + lifecycle platform, and that is where nearly all the distance is. The gaps cluster **not in "can it run a pipeline"** (it can) but in **"can you see, debug, version, map, reuse, and safely operate it."**

Two important framings before the list:
1. **Some gaps are intentional design divergence, not deficiencies.** Workato steps are deterministic typed *connector actions*; our steps are whole *LLM agents*. Chasing literal "1000+ connectors + typed actions" parity fights the platform's premise. The valuable parity targets are operability, data mapping, control flow, and lifecycle — not connector count.
2. **Full parity is a multi-quarter program**, several times the effort spent building v1. The roadmap below is sequenced so the highest day-to-day value (making flows *observable and trustworthy*) lands first.

## Parity scorecard

| Dimension | Parity | Biggest gap |
|---|--:|---|
| Control-flow logic | 28% | No nested control flow; binary conditions only; no sub-flow / stop node |
| Reusability & shared assets | 25% | No callable sub-flow; no typed flow IO; no lookup tables |
| Triggers & scheduling | 24% | Schedule UI missing *and* stored shape never fires; no webhook/polling |
| Actions, connectors & coverage | 24% | Steps are whole agents, not typed deterministic actions; no HTTP node |
| AI Copilot | 24% | One-shot, graph-blind, destructively overwrites the canvas |
| Canvas & builder UX | 22% | No undo, zoom/pan, multi-branch wiring, or drag data-mapping |
| Jobs, observability & monitoring | 18% | No run-history UI; no per-step input/output inspection; no replay |
| Testing & debugging | 17% | No custom test input; no per-step I/O; per-step errors never shown |
| Data mapping & transformation | 14% | No typed schemas / datatree / formula mode — whole-output chips only |
| Versioning, environments & lifecycle | 12% | No versions/revert; no draft-vs-published; no environments |
| Error handling & retries | 12% | No retry/backoff; no try-catch; loop/branch errors swallowed |
| Collaboration & governance | 12% | RBAC role enum is dead for flows; no folders; flows emit no audit events |

## Load-bearing engine limits (cross-cutting — they gate several dimensions)

These are structural properties of `interpret.ts` / `execute-flow.ts` that block parity in *multiple* dimensions at once, so they earn priority:

- **No resume-after-pause.** `interpretFlow` always restarts from `trigger`; completed steps are not skipped. Re-running a `waiting` run re-executes every prior agent and writes duplicate `FlowRunStep` rows. Answer-and-continue for ask-user is structurally impossible today. → gates testing, error-repair, waiting-run monitoring.
- **Control flow does not nest.** Loop bodies and parallel branches run only `agent` nodes (`if (bodyNode.type !== 'agent') continue`). No loop-in-loop, no condition-in-loop. → gates logic parity.
- **Containers can't fail or pause.** A waiting/error result inside a loop item or parallel branch is swallowed; the container is *always* recorded `succeeded`. → gates error-handling + observability.
- **Only agent nodes persist as steps.** condition/loop/parallel/trigger outcomes live only in memory. Loop iterations collide under one `nodeId` with a racy `order`. → gates monitoring + debugging.
- **Substitution-only templates + literal condition RHS.** No arithmetic/functions/defaults; `cond.right` isn't templated (can't compare two dynamic values). → gates data mapping + logic.

## Roadmap

### P1 — Make it trustworthy & debuggable (operability table-stakes)
*Goal: you can see exactly what a run did, test with real input, and edits are safe. This is what makes Flows usable day-to-day and is the highest-leverage phase.*

1. **Run-history + per-step I/O panel** (jobs, blocker/M) — a runs drawer on `/flows/[id]` reading `FlowRun`/`FlowRunStep` (input/output already persisted); list past runs, expand a run to see each step's resolved input + output + error.
2. **Persist all node outcomes** (jobs, medium/M) — write `FlowRunStep` rows for condition/loop/parallel too; give loop iterations distinct `nodeId#i` + stable order so they don't collide.
3. **Surface per-step status + error in the canvas/drawer** (testing, high/S) — colour the failed card, show the message, and deep-link the step to its underlying `AgentExecution` transcript.
4. **Custom test input** (testing, blocker/S) — a "Run with input" field feeding `{{trigger.input}}`.
5. **Visibility-scope the `/runs` endpoint** (governance, medium/S — real leak) — private-flow run history currently returns to the whole org; add `agentVisibilityScope`.
6. **Draft-vs-published + run snapshot** (versioning, blocker/L + medium/S) — a published graph separate from the working draft; stamp each `FlowRun` with the graph JSON it executed.

### P2 — Complete the engine & logic (correctness)
*Goal: the pipelines you can draw actually behave like a real orchestrator.*

1. **Resume-after-pause** (engine) — persist an execution cursor on `FlowRun`, skip completed steps, and implement answer-and-continue for ask-user (reuse the agent resume mechanics). Unblocks waiting runs everywhere.
2. **Nested control flow** — let loop bodies / parallel branches contain condition/loop/parallel, not just agents.
3. **Richer conditions** — multi-criteria AND/OR groups, templated right operand, and a multi-way branch / switch instead of binary true/false; plus an explicit **Stop** node and action-level "run only if…" conditions.
4. **Error semantics** — errors inside loops/parallel propagate (or honour `onError`); add retry-with-backoff and a per-step timeout; a monitor/rescue (try-catch) block.
5. **Loop ergonomics** — expose the loop index, make inner-step outputs addressable downstream, and make the parallel node creatable/configurable in the builder.

### P3 — Data mapping & builder "feel"
*Goal: the Workato mapping and canvas experience.*

1. **Typed step schemas + datatree** (data mapping, blocker/XL) — declare/inferred input/output schemas per step so a draggable field picker ("datapills") can replace whole-output chips.
2. **Formula / expression mode** (data mapping, blocker/XL) — arithmetic, functions, defaults, conditionals in mappings.
3. **Canvas engine** (canvas, XL) — multi-branch rendering + wiring, undo/redo, zoom/pan/fit, step reorder, add-step *type* picker, editable labels, notes, copy/paste. (Effectively adopting a React-Flow-class canvas.)
4. **Copilot v2** (copilot, high/L) — conversational + graph-aware + non-destructive diff preview (accept/reject) instead of one-shot overwrite.

### P4 — Reuse, triggers, governance & scale
*Goal: flows compose, trigger on real events, and are safe for a team.*

1. **Callable sub-flow node + typed flow IO** (reuse, blocker/XL) — a flow can invoke another flow; the run_agent primitive is the model to generalise.
2. **Real triggers** (triggers, blocker) — webhook/callable + a schedule config UI wired to the (currently inert) stored shape + polling triggers with a persisted cursor + trigger conditions.
3. **Governance** (governance) — folders/projects, RBAC for flows (the role enum is dead), emit audit events (infra already exists), approvals inside flows.
4. **Lifecycle** (versioning) — version history + revert, clone, environments (dev/test/prod), export/import.
5. **Deterministic action step + HTTP connector** (actions) — an optional pinned-tool / HTTP node for when a step must be deterministic rather than agent-mediated; lookup tables / shared variables.

## Top 5 quick wins (do these first — S/M effort, high impact)

1. **Custom test input field** (testing, S) — unblocks all meaningful testing.
2. **Visibility-scope `/runs`** (governance, S) — closes a real private-data leak.
3. **Show per-step error + status in the drawer** (testing, S) — turns silent failures visible.
4. **Template the condition right-hand side** (data mapping, S) — one-line fix, removes a real logic limitation.
5. **Clone flow + editable step label + insert-type picker** (reuse/canvas, S) — cheap, high-frequency UX wins.

## Top 5 hardest / biggest bets (XL — plan deliberately)

1. Typed schemas + datatree + formula engine (data mapping) — Workato's deepest moat.
2. Full canvas engine (zoom/pan/drag-map/multi-branch) — a React-Flow-class rewrite.
3. Callable sub-flows with typed IO (reuse) — real composition.
4. Environments + deploy API/CLI + Git (versioning) — enterprise lifecycle.
5. Deterministic typed action steps + connector SDK (actions) — partly a design divergence; pursue selectively.
