# DAG Flow Engine — Phase 1 (execution engine)

Date: 2026-07-14
Status: Design (awaiting review)
Scope: Phase 1 of 2. Phase 1 = the headless DAG execution engine + validation +
resume. Phase 2 (separate spec) = the builder canvas for authoring DAGs
(free-form multi-parent edges, graph layout, `mutate.ts`). This spec covers
Phase 1 only.

## Goal

Let a flow be a true directed acyclic graph: several nodes can fan into one
node, that node runs once after its inputs resolve, and it sees the data from
every upstream path that ran. Fan-in must be correct even when some upstream
paths are gated by a Condition/Switch (dead-path elimination / OR-join), and
independent ready nodes run concurrently.

Today the interpreter is a single-active-path walk (`while (current)` in
`src/features/flows/interpret.ts`): one pointer, one edge at a time; Conditions/
Switches pick exactly one branch; `loop`/`parallel` are self-contained container
nodes; `join` is a passthrough that assumes only one branch reaches it. This
spec replaces the orchestration walk with a dependency scheduler while keeping
per-node execution (`execNode`) untouched.

## Non-negotiable: back-compat

Every existing linear / branch / loop / parallel graph MUST execute identically
on the new scheduler. The full existing `src/features/flows/__tests__/interpret.test.ts`
suite is the regression gate and must pass unchanged. `execNode` (per-node logic
for all node types — it already writes `ctx.step[id]`, handles adapters,
approvals, structured output, upstream context, etc.) is reused as-is; only the
`while (current)` loop that decides WHICH node runs next is replaced.

## Execution model

### Node + edge state

Node runtime state (in-memory, per run):
- `pending` — inputs not yet resolved
- `ready` — all incoming edges resolved and ≥1 active → eligible to run
- `running`
- `done` — completed; output written to `ctx.step[id]`
- `skipped` — dead-path eliminated (all incoming edges dead), or a filter drop
- `failed`

Edge state: `unresolved` → `active` (branch taken) or `dead` (branch not taken).

### Readiness (OR-join / dead-path elimination)

- A node is *resolvable* when EVERY incoming edge is terminal (active or dead).
- Resolvable with ≥1 `active` incoming → the node RUNS.
- Resolvable with ALL incoming `dead` → the node is SKIPPED; every outgoing edge
  of a skipped node becomes `dead`. Deadness propagates transitively.
- The `trigger` has no incoming edges; it is the root and activates its outgoing
  edges with the run input as its output.

This is exactly what makes fan-in correct under branching: a join downstream of a
Condition runs once the taken branch reaches it, because the untaken branch's
edges go dead and no longer block readiness.

### Edge resolution on node completion

`execNode` returns a `NodeResult`. The scheduler maps each result to edge
activations on the node's OUTGOING edges:

| Result | Outgoing edges |
|---|---|
| `ok` | activate all non-`error` edges (fan-out to all successors); dead the `error` edge if present |
| `branch` (new: condition/switch — see below) | activate the chosen branch edge; dead the others |
| `route` (onError:route failure) | activate the `error` edge if present, else activate the normal edge (continue-like); dead the normal edge when the error edge is taken |
| `fail` (onError:stop) | fail the whole run |
| `drop` (filter didn't pass) | dead all outgoing edges (this sub-path ends locally). Back-compat: on a linear graph this ends the flow, and the run output stays the value carried INTO the filter (the last `done` node before it), exactly as today — see Termination |
| `stop` | activate nothing; terminate the whole run (success) |
| `pause` | pause the whole run (`waiting`) |
| `skip` (trigger/no-op) | activate all outgoing edges |

New `NodeResult` kind `{ kind: 'branch', branch: string, output? }`: today
Condition/Switch are decided inline in the `while` loop, not in `execNode`. In
the DAG model, `execNode` evaluates them (via the existing `evalCondition` /
`evalClause`) and returns which branch is active so the scheduler can resolve
edges uniformly. Their `output` is recorded like today (`hit?.id ?? 'default'`
for switch; the boolean branch for condition) for inspectability.

### Concurrency

Maintain a ready set. Run up to `MAX_CONCURRENT_NODES` (default 8) ready nodes at
once via a bounded pool (the same `mapLimit` helper the `loop` node already
uses). Each completion resolves outgoing edges, which may move successors to
`ready`. The run loop continues until no node is `running` and none is `ready`.

Shared-state caveat (explicit, unchanged from today's `parallel`): concurrent
branches that write the same `{{var.*}}` have undefined write ordering. We do NOT
add locking; the constraint is documented, matching existing `parallel`
semantics.

### Containers (loop / parallel) unchanged

`loop` and `parallel` remain single nodes in the outer DAG. `execNode` runs their
bodies internally exactly as today. The scheduler treats them like any other
node (one `execNode` call, one output). No change to container internals.

### `join` node

Still valid and still useful as an explicit merge point. Its output:
- exactly one active parent → that parent's output (today's behavior);
- multiple active parents (a real fan-in) → an aggregate object keyed by step
  label (reusing `aggregateSteps`), so downstream can read each.

A join whose incoming edges are all dead is skipped like any other node.

### Termination & run output

The run ends when the scheduler goes quiescent (nothing ready or running), or a
`stop`/`fail`/`pause` short-circuits it.

Output resolution (in priority order):
1. If any `output` node ran → `namedOutputs` (as today).
2. Else, the run output is the output of the terminal SINK(s) — a `done` node
   with no `active` outgoing edge. One sink → its output (back-compat: a linear
   graph has exactly one sink, so identical to today). Multiple sinks → an
   aggregate object keyed by step label.
3. If no node produced an output on the taken path (e.g. a filter dropped and
   ended the only path), the run output is the last value carried into that dead
   end — i.e. the most recent `done` node's output along the path that ran. This
   preserves today's linear filter-drop behavior (`status: succeeded`, output =
   the pre-filter value).

`InterpretResult` shape is unchanged (`status`, `steps`, `output`, `waiting?`,
`error?`, `namedOutputs?`).

### Failure / pause / stop

- `fail` (onError:stop, or an unhandled error): the run fails immediately. In-
  flight concurrent nodes are allowed to settle but their results are ignored;
  the run is marked `failed` with the failing node's error. The end-of-run
  phantom-`running` sweep in `execute-flow.ts` already closes abandoned rows.
- `stop`: terminate the whole run successfully (matches today — `stop` is an
  explicit "end the flow early", not a per-branch stop).
- `pause` (ask-user / approval): the run pauses `waiting`. In-flight siblings
  settle first; then the run persists as `waiting` on the paused node. Resume
  below.

### Resume / replay

On resume the scheduler is reconstructed from persisted `FlowRunStep` rows +
`opts.completed`:
1. `done` nodes: output restored into `ctx.step` from `completed` (as today).
2. `skipped` nodes: restored from persisted `skipped` step rows → their outgoing
   edges are dead.
3. Condition/Switch nodes that are `done`: re-evaluate deterministically from the
   restored `ctx` to recover the taken branch, then resolve their edges. (Branch
   selection is a pure function of `ctx`; restoring inputs restores the choice —
   the codebase already depends on this determinism for replay.)
4. Edge states are derived by replaying the recorded completions in `order`.
5. The paused node re-runs with `resumeReply` injected; the scheduler then drains
   the remaining `pending` nodes.

Re-run-from-a-step (`replayFrom`) works the same way: replay recorded outcomes
before the cutoff, then let the scheduler execute the chosen node and everything
downstream fresh.

## Validation changes (`src/lib/flows/validate.ts`)

- **Multi-incoming is now legal.** Remove/relax any single-parent assumption.
  The current linear-spine reachability warning stays as a warning.
- **Cycle detection (new, error `CYCLE`).** The graph (excluding container-
  internal bodies, which are ordered lists) must be acyclic. DFS over edges;
  report the offending nodes.
- **Back-edges disallowed.** Today an `onError: route` `error` edge may loop
  back with a visit budget. In a DAG scheduler a back-edge is a cycle and would
  deadlock (a node never becomes resolvable). This is the one behavior change:
  error edges must go forward. Flows that used a back-looping error edge for
  retry should use the node's `retries` field instead (already supported). The
  validator reports these as `CYCLE` with a message pointing at `retries`.
- **Join reachability** unchanged (still a warning if unreachable).

## Files touched (Phase 1)

- `src/features/flows/interpret.ts` — replace the `while (current)` walk with the
  dependency scheduler; add the `branch` NodeResult for condition/switch; edge-
  state + dead-path logic; concurrency pool; termination/output; resume
  reconstruction. `execNode` body reused.
- `src/features/flows/context.ts` — reuse `aggregateSteps` for multi-parent join
  output (helper already exists; likely no change).
- `src/lib/flows/validate.ts` — cycle detection; allow multi-incoming.
- `src/features/flows/execute-flow.ts` — resume path already loads all step rows;
  ensure `skipped` rows feed the reconstruction. Minor.
- `src/lib/flows/copilot-grounding.ts` — teach the copilot it may now emit fan-in
  (multiple edges into one node) and must keep graphs acyclic.

## Testing (the contract)

Regression:
- Entire existing `interpret.test.ts` passes unchanged (linear, branch, loop,
  parallel, join, error-route-forward, resume, replay).

New (DAG):
- **AND-join**: 3 independent nodes → 1 agent; all 3 run (concurrently), the
  agent runs once and sees all three outputs.
- **OR-join / dead-path**: Condition → (true→A, false→B) → both A and B → join;
  only the taken side runs, join runs once, output is the live side.
- **Diamond**: trigger → {X, Y} → Z; Z runs once after both X and Y.
- **Multi-sink output**: two terminal sinks → aggregate output; single sink →
  bare output (back-compat).
- **Concurrency**: independent parents overlap in time (observable via a
  start/finish probe), and the join waits for all.
- **Resume across a DAG**: pause on one branch of a diamond; resume completes the
  rest exactly once (no re-firing of the completed branch's side effects).
- **Cycle rejection**: a graph with a cycle (incl. a back-looping error edge)
  fails validation with `CYCLE`.
- **Skip propagation**: a fully-dead subtree is all `skipped`, none executed.

## Non-goals (Phase 1)

- No canvas / builder UI changes (Phase 2). Phase 1 is exercised via hand-
  authored graphs and the copilot; it is the foundation, not yet user-drawable.
- Container (loop/parallel body) internals unchanged.
- No variable-write locking across concurrent branches (documented constraint).
- Cycles / back-edges unsupported by design.

## Open decision resolved

- Back-edges: **disallowed** (validation `CYCLE`). Rationale: they can't coexist
  with dependency scheduling, and `retries` already covers the retry use case.
