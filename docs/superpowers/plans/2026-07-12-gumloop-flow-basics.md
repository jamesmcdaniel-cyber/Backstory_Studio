# WS11: Gumloop Flow-Basics Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spec §11 — close the confirmed Gumloop Flow-Basics gaps: context tokens (`{{now}}` / run metadata), trigger input default values, an Output node (named flow outputs), a Join node (branch merge), and error-path routing (Error Shield's success/error split).

**Architecture:** Token/schema additions where token-native (datetime, run metadata, input defaults); two new graph node types (`output`, `join`) with pure interpreter semantics; one interpreter routing addition (`onError: 'route'` + labeled error edge). UX + copilot ripple in a dedicated task, mirroring WS10.

**Tech Stack:** zod graph schema, pure interpreter (node:test TDD), Next.js.

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Capture the live baseline before each task (concurrent sessions move it; last seen ~618 local / ~698 CI-mode, 4–7 pre-existing lint warnings — report exact before/after). Never run dev/build/prisma; CI-mode gate on a SESSION-UNIQUE DB before push (see memory `ci-github-actions-gate`).
- NO raw `{{`/enum strings user-visible. Storage stays canonical `{{...}}`; new tokens humanize via `friendlyTokenLabel`.
- **New-node-type ripple checklist** (for `output`/`join` — touch ALL or state why not): `src/lib/flows/graph.ts` (zod union), `src/lib/flows/mutate.ts` (StepType default data), `src/lib/flows/validate.ts`, `src/features/flows/interpret.ts`, `src/lib/flows/copilot-ops.ts` (STEP_TYPES), `src/lib/flows/copilot-grounding.ts` (graphRules), `src/app/api/flows/copilot/chat/route.ts` (OPS_CONTRACT type list), `src/lib/flows/builtin-catalog.ts` (picker manifest), `src/components/flows/flow-canvas.tsx` (titleFor/subtitleFor/icon), `src/components/flows/step-card.tsx` + `step-drawer.tsx` (editors + NODE_TYPES select), `src/lib/flows/token-text.ts` `stepLabelsOf` (generic capitalize covers plain types — verify).
- Engine tasks (1–5) may add NEUTRAL typecheck-satisfying placeholders in flow-canvas/step-card (title string, icon/tone) and MUST list them for Task 6 — do NOT build editors in engine tasks.
- Interpreter grounding (verified file:line): node union `graph.ts:259-261`; `condition` walk `interpret.ts:647-653`, `switch` `655-663`; `lastOutput` seed/return `interpret.ts:643,670,681`; ctx build `interpret.ts:623`; readPath roots `context.ts:20-38`, FlowContext type `context.ts:7-17`, resolveTemplate `context.ts:41-63`; `FlowRun.output` write `execute-flow.ts:555`; `flow.completed` payload `execute-flow.ts:611-616`; webhook response `src/app/api/flows/[id]/trigger/route.ts:57-65`; input/required-check `execute-flow.ts:153-176`; trigger field schema `graph.ts:23,27`; normalizer `trigger.ts:47-55`.

---

### Task 1: Context tokens — `{{now}}`, `{{flow.*}}`, `{{run.*}}` (TDD)

**Files:** `src/features/flows/context.ts` (readPath + FlowContext), `src/features/flows/interpret.ts` (ctx build + interpretFlow options), `src/features/flows/execute-flow.ts` (pass metadata in), `src/lib/flows/token-text.ts` (friendlyTokenLabel), `src/lib/flows/datatree.ts` + page (DataTree roots) — deferred datatree UI to Task 6; here just the engine + token label + tests.

**Design (Produces):**
- `FlowContext` gains optional `now?: { iso, date, time, unix }` and `run?: { id, url, trigger, startedAt, flowId, flowName }`.
- `readPath` roots: `now.*` and `flow.*`/`run.*` — map `{{flow.id}}`→run.flowId, `{{flow.name}}`→run.flowName, `{{run.id}}`, `{{run.startedAt}}`, `{{run.trigger}}`, `{{run.url}}`. `{{now}}`→iso; `{{now.date}}`/`{{now.time}}`/`{{now.unix}}`.
- `interpretFlow` gains options `{ now?, run? }`; execute-flow supplies them (`now` = a single captured `new Date()` at run start so all `{{now}}` in a run agree; `run` from the FlowRun row + a builder deep-link url `/flows/<flowId>?run=<runId>`). Resume reuses the run's original startedAt.
- `friendlyTokenLabel`: `now`→'Current time', `now.date`→'Today's date', `run.id`→'This run › id', `flow.name`→'This flow › name', etc.

- [ ] Failing tests in `src/features/flows/__tests__/interpret.test.ts` (or context test): `{{now}}` resolves to the injected iso; `{{flow.name}}`/`{{run.id}}` resolve; unknown `{{run.bogus}}` → '' (not crash); `{{now}}` is stable across two steps in one run (same injected clock). token-text test for the new labels.
- [ ] Implement → full gate → commit `feat(flows): now + run metadata tokens — {{now}}, {{flow.name}}, {{run.id}}`

---

### Task 2: Trigger input default values (TDD)

**Files:** `src/lib/flows/graph.ts` (triggerInputFieldSchema `default?`), `src/lib/flows/trigger.ts` (normalizer reads `default`), `src/features/flows/execute-flow.ts` (apply defaults before required-check), `src/lib/flows/input-validation.ts` (verify missing-check sees post-default input).

**Design:** `triggerInputFieldSchema` gains `default: z.string().optional()`. At run start, for each declared input field with a `default` whose value is absent/blank in the provided input, fill it from `default` BEFORE `missingRequiredInputFields` runs (so a defaulted required field is satisfied). Applies to manual + scheduled + webhook (all flow through runFlowExecution). Document precedence: explicit input > default > last-successful-reuse fallback.

- [ ] Tests: a required field with a default and no provided value → run proceeds using the default; explicit value overrides default; a field with neither → still FLOW_INPUT_ERROR. Extract the merge as a pure helper `applyInputDefaults(fields, input)` + node:test.
- [ ] Implement → gate → commit `feat(flows): trigger inputs support default values`

---

### Task 3: Output node — named flow outputs (TDD, ripple)

**Files:** ripple checklist. Engine + tests here; editor in Task 6.

**Design (Produces):**
- Node `{ type: 'output', data: { outputs: { name: string, value: string (templated), type?: 'text'|'list'|'any' }[], label?, note? } }`. Default data: one output `{ name: 'output', value: '', type: 'any' }`.
- Interpreter: an `output` node RESOLVES each `value` template and records a named-output map; execution continues (it's a passthrough, not a terminator). If multiple output nodes run, later names merge/override. `interpretFlow` returns `namedOutputs` alongside `output`.
- `FlowRun.output`: when any output node ran → the named object `{ <name>: value }`; otherwise unchanged (last-step `lastOutput`) for back-compat.
- `flow.completed` payload `output` and the webhook trigger response carry the named object when present.
- validate: duplicate output names → error; empty name → error (`{label} needs a name for each output.`).

- [ ] Tests: output node records named values from templates; two outputs → both present; FlowRun-shaped return carries the named object; no output node → last-step behavior preserved (regression). Downstream: a step after an output node still runs (passthrough).
- [ ] Implement (ripple: neutral canvas title 'Output' + step-card icon/tone placeholder, listed for Task 6) → gate → commit `feat(flows): output node — flows return named outputs to callers`

---

### Task 4: Join node — branch merge (TDD, ripple)

**Files:** ripple checklist. Engine + tests here.

**Design (Produces):**
- Node `{ type: 'join', data: { label?, note? } }` (no config — pure passthrough). Default data `{}`.
- Interpreter: a `join` node is reached by whichever branch's edge points at it; it forwards that branch's incoming value as its own output (`lastOutput` passthrough) and continues down its single outgoing edge. Only-one-active semantics fall out of the existing linear walk — the KEY change is making it a legal, addressable merge target that condition/switch/error branches can all point at, and whose output is "whatever ran". No buffering, no waiting.
- Verify against the existing walk: condition/switch already follow one edge; a join is just a normal node they can target. The value-add is (a) the node exists as a picker/canvas primitive, (b) its output is documented as "the value from whichever path ran", (c) parallel's aggregate is unaffected.
- validate: a join with no incoming edge → warning (`{label} isn't reached by any branch.`); with one incoming → fine (harmless).

- [ ] Tests: condition true-branch → join → downstream reads the join output = the true branch's last value; false-branch symmetric; join reachable from switch cases.
- [ ] Implement (ripple: neutral title 'Join', icon/tone placeholder) → gate → commit `feat(flows): join node — merge branches back into one path`

---

### Task 5: Error-path routing — `onError: 'route'` (TDD)

**Files:** `src/lib/flows/graph.ts` (onError enum gains `'route'` on agent/tool/http), `src/features/flows/interpret.ts` (route on failure), `src/lib/flows/validate.ts` (route requires an error edge).

**Design (Produces):**
- `onError` becomes `'stop' | 'continue' | 'route'` on agent/tool/http (graph.ts:43,95,121).
- Interpreter: when a step with `onError: 'route'` fails, its output becomes `{ error: <message>, input: <the resolved step input> }` (pass-inputs-through), and the walk follows the node's labeled `error` outgoing edge instead of the normal one. Reuse the condition edge-follow machinery (`outgoing(nodeId, 'error')`). If no error edge exists, behave as `continue` (output the error object, follow the normal edge) — never crash.
- A step after the error edge can read `{{step.<id>.output.error}}` / `.input` and, e.g., route to a Join.
- validate: `onError: 'route'` with no error-labeled outgoing edge → warning (`{label} routes on error but has no error path — failures continue on the normal path.`).

- [ ] Tests: a failing tool step with onError route + an error edge → downstream error-branch step runs and reads `{{step.x.output.error}}`; the input is preserved; no error edge → falls through to normal edge (continue-like) without crashing; onError stop/continue unchanged (regression).
- [ ] Implement → gate → commit `feat(flows): steps can route failures down an error path — Error Shield parity`

---

### Task 6: Builder UX + copilot for output / join / error-path

**Files:** builtin-catalog.ts, flow-picker.tsx, flow-canvas.tsx, step-card.tsx, step-drawer.tsx, copilot-ops.ts, copilot-grounding.ts, chat route OPS_CONTRACT, datatree.ts + page (Now/This-run roots + input defaults column).

**Work:**
- Picker: a `Flow basics` group (or extend the existing basics group) with `Output` and `Join paths` leaves seeding the nodes; keep them near Condition/Switch/Stop.
- Editors (drawer AND card): output → a repeatable name/value(TokenTextEditor)/type rows list with add/remove; join → label/note only; the `onError` select on agent/tool/http gains a third option 'Route failures to an error path' (writes `onError:'route'`); trigger input-field editor gains a Default column (TokenTextEditor or plain input) writing `default`.
- Canvas: real titleFor/subtitleFor for output ('Output' + first name) and join ('Join paths'); RENDER the labeled `error` edge distinctly (a subtle red/amber edge label 'on error') where a node has onError:'route' — check how condition true/false edges render and mirror.
- DataTree: add a 'Now' root (`{{now}}` + date/time/unix children) and a 'This run' root (`{{run.id}}`, `{{flow.name}}`, etc.), typed, description 'Set automatically for every run.'
- Copilot: STEP_TYPES += output, join; grounding graphRules document both node shapes + the `onError:'route'` option + the new tokens; OPS_CONTRACT add-op type list += output, join.
- Replace all neutral placeholders from Tasks 3–4.

- [ ] Implement → gate → commit `feat(flows): output, join, error-path, and context tokens in the builder + copilot`

---

### Task 7: Final verification + review + push

- [ ] Full local gate; whole-workstream review (emphasis: interpreter regressions for existing node types; FlowRun.output back-compat when no output node; error-edge follow can't infinite-loop; token injection doesn't leak run.url with secrets). Fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB + build; push; confirm CI green.
