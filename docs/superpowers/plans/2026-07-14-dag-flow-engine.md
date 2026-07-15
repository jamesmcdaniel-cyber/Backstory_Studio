# DAG Flow Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flow interpreter's single-active-path walk with a dependency scheduler so a flow can be a true DAG — multiple nodes fan into one node, which runs once after its inputs resolve and sees every upstream path that ran, with dead-path elimination for conditional branches and concurrent execution of independent ready nodes.

**Architecture:** Keep `execNode` (per-node execution for every node type) untouched; replace only the `while (current)` orchestration in `interpretFlow` with a scheduler that tracks node/edge state, resolves edges on completion, eliminates dead paths (OR-join), runs ready nodes concurrently (bounded), and terminates when quiescent. Condition/Switch branch-selection moves into `execNode` via a new `branch` result so the scheduler resolves all edges uniformly. Validation gains cycle detection; back-edges become invalid.

**Tech Stack:** TypeScript, Next.js, Node's built-in test runner (`node:test` via `tsx`), Zod graph schema. Reference: `docs/superpowers/specs/2026-07-14-dag-flow-engine-design.md`.

## Global Constraints

- **Back-compat is the gate:** the entire existing `src/features/flows/__tests__/interpret.test.ts` MUST pass unchanged after every task. Existing linear/branch/loop/parallel/join/error-route/resume/replay behavior is preserved exactly.
- `execNode` per-node logic is reused as-is; only orchestration is replaced.
- Containers (`loop`/`parallel`) remain single nodes in the outer DAG; their body internals are untouched.
- Concurrency default: 8 (`MAX_CONCURRENT_NODES`). Concurrent branches writing the same `{{var.*}}` have undefined ordering (documented, matching today's `parallel`).
- Cycles/back-edges are invalid (validation error `CYCLE`); the retry use-case uses the node `retries` field.
- Verification per task: `npx tsc --noEmit` clean, `npm run lint` (0 errors), the named tests pass. Final task also runs the full suite against local `ci_repro` Postgres and a CI-mode build (see `docs/superpowers/plans/2026-07-10-remediation-ws2-flow-durability-parity.md` for the exact `ci_repro` commands).
- Test runner invocation: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <files>`.

## File Structure

- `src/features/flows/interpret.ts` — MODIFY. Add the `branch` NodeResult; move condition/switch decision into `execNode`; replace the `while (current)` walk (~lines 878–931) with the scheduler. New internal module-scope helpers live in a new file to keep `interpret.ts` focused.
- `src/features/flows/dag-scheduler.ts` — CREATE. Pure, dependency-free graph helpers used by the scheduler: edge/adjacency maps, edge-resolution rules, skip propagation, readiness, sink detection, cycle detection. Testable in isolation.
- `src/features/flows/__tests__/dag-scheduler.test.ts` — CREATE. Unit tests for the pure helpers.
- `src/features/flows/__tests__/interpret.test.ts` — MODIFY (append). New DAG execution tests (fan-in, dead-path, diamond, concurrency, multi-sink, resume).
- `src/lib/flows/validate.ts` — MODIFY. Cycle detection; allow multi-incoming.
- `src/lib/flows/__tests__/validate.test.ts` — MODIFY (append). Cycle/back-edge tests.
- `src/lib/flows/copilot-grounding.ts` — MODIFY. Teach the copilot it may emit fan-in and must keep graphs acyclic.

---

### Task 1: `branch` NodeResult — condition/switch decide inside `execNode`

Move Condition/Switch branch-selection out of the walk and into `execNode`, returning a new `{ kind: 'branch', branch, output }`. The existing walk is updated to consume it, so behavior is unchanged — this isolates branch logic so the scheduler (Task 2) resolves every node's edges the same way.

**Files:**
- Modify: `src/features/flows/interpret.ts` (NodeResult type ~79–91; the walk's condition/switch blocks ~887–903; add condition/switch cases in `execNode`)
- Test: `src/features/flows/__tests__/interpret.test.ts` (existing suite is the gate)

**Interfaces:**
- Produces: `NodeResult` gains `| { kind: 'branch'; branch: string; output: unknown }`. `execNode` returns `branch` for `condition` and `switch` nodes; `branch` is `'true'`/`'false'` for condition, the matched case id or `'default'` for switch. `output` mirrors what the walk emitted before (condition: the boolean; switch: `hit?.id ?? 'default'`).

- [ ] **Step 1: Add a failing test asserting condition/switch still route (regression pin).**

Append to `interpret.test.ts`:

```ts
test('condition/switch selection is unchanged after moving into execNode', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
      { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.output, 'HIGH')
})
```

- [ ] **Step 2: Run the full existing suite to confirm it currently passes (baseline).**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS (this new test passes against the current inline handling too — it's the pin we must keep green through the refactor).

- [ ] **Step 3: Add the `branch` kind to `NodeResult`.**

In `interpret.ts`, in the `NodeResult` union (after the `route` member):

```ts
  | { kind: 'route'; output: unknown }
  // A condition/switch decision — the scheduler activates the matching branch
  // edge and deads the rest. `output` mirrors the recorded outcome value.
  | { kind: 'branch'; branch: string; output: unknown }
```

- [ ] **Step 4: Handle condition/switch inside `execNode`.**

In `execNode`, add these BEFORE the final `return { kind: 'skip' }`:

```ts
    if (node.type === 'condition') {
      const branch = evalCondition(node.data, ctx) ? 'true' : 'false'
      emit({ nodeId: node.id, status: 'succeeded', output: branch === 'true' })
      return { kind: 'branch', branch, output: branch === 'true' }
    }

    if (node.type === 'switch') {
      const hit = node.data.cases.find((c) => evalClause({ left: c.left, op: c.op, right: c.right }, ctx))
      const branch = hit ? hit.id : 'default'
      emit({ nodeId: node.id, status: 'succeeded', output: branch })
      return { kind: 'branch', branch, output: branch }
    }
```

- [ ] **Step 5: Update the walk to consume `branch` instead of deciding inline.**

Replace the walk's condition and switch blocks (the two `if (current.type === 'condition')` / `'switch'` blocks near the top of `while (current)`) with nothing — delete them — and update the generic step handling so a `branch` result follows the chosen edge. In the walk, after `const res = await execNode(current, ctx)`, add branch handling alongside the existing result handling:

```ts
    if (res.kind === 'branch') {
      const edge = outgoing(current.id, res.branch)
      let next = edge ? byId.get(edge.target) : undefined
      while (next && contained.has(next.id)) {
        const skip = normalOutgoing(next.id)
        next = skip ? byId.get(skip.target) : undefined
      }
      current = next
      continue
    }
```

(Place this immediately after the `overBudget()`/pause/fail/stop/drop handling for `res`, before the normal-edge advance. The condition/switch `overBudget` guard they had is now covered by `execNode`'s own `overBudget()` at its top.)

- [ ] **Step 6: Run the full suite — behavior unchanged.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS (all existing tests + the new pin).

- [ ] **Step 7: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit.**

```bash
git add src/features/flows/interpret.ts src/features/flows/__tests__/interpret.test.ts
git commit -m "refactor(flows): condition/switch decide inside execNode via a 'branch' result"
```

---

### Task 2: Pure DAG helpers (`dag-scheduler.ts`)

Create the pure, dependency-free graph helpers the scheduler will use. No execution here — just data structures and rules, unit-tested in isolation.

**Files:**
- Create: `src/features/flows/dag-scheduler.ts`
- Test: `src/features/flows/__tests__/dag-scheduler.test.ts`

**Interfaces:**
- Produces:
  - `type EdgeState = 'unresolved' | 'active' | 'dead'`
  - `type NodeRunState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'`
  - `buildAdjacency(nodes: {id:string}[], edges: FlowEdge[], contained: Set<string>): { incoming: Map<string, FlowEdge[]>; outgoing: Map<string, FlowEdge[]>; dagNodeIds: string[] }` — excludes container-internal nodes/edges.
  - `edgeActivationsFor(result: 'ok'|'route'|'drop'|'skip'|{branch:string}, outEdges: FlowEdge[]): Map<FlowEdge, 'active'|'dead'>` — the edge-resolution rules from the spec table.
  - `findCycle(dagNodeIds: string[], outgoing: Map<string, FlowEdge[]>): string[] | null` — returns a node-id cycle or null.

- [ ] **Step 1: Write failing tests for the helpers.**

Create `src/features/flows/__tests__/dag-scheduler.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowEdge } from '@/lib/flows/graph'
import { buildAdjacency, edgeActivationsFor, findCycle } from '../dag-scheduler'

const e = (id: string, source: string, target: string, branch?: string): FlowEdge => ({ id, source, target, ...(branch ? { branch } : {}) })

test('buildAdjacency indexes incoming/outgoing and excludes contained nodes', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'bodyNode' }]
  const edges = [e('1', 'a', 'b'), e('2', 'a', 'c'), e('3', 'b', 'c')]
  const { incoming, outgoing, dagNodeIds } = buildAdjacency(nodes, edges, new Set(['bodyNode']))
  assert.deepEqual(dagNodeIds.sort(), ['a', 'b', 'c'])
  assert.equal(outgoing.get('a')!.length, 2)
  assert.equal(incoming.get('c')!.length, 2)
  assert.equal(incoming.get('a')!.length, 0)
})

test('edgeActivationsFor: ok fans out to all non-error edges, deads error', () => {
  const outs = [e('1', 'a', 'b'), e('2', 'a', 'err', 'error')]
  const acts = edgeActivationsFor('ok', outs)
  assert.equal(acts.get(outs[0]), 'active')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('edgeActivationsFor: branch activates the chosen edge, deads the rest', () => {
  const outs = [e('1', 'c', 't', 'true'), e('2', 'c', 'f', 'false')]
  const acts = edgeActivationsFor({ branch: 'true' }, outs)
  assert.equal(acts.get(outs[0]), 'active')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('edgeActivationsFor: route takes error edge if present, else normal (continue-like)', () => {
  const withErr = [e('1', 'a', 'b'), e('2', 'a', 'err', 'error')]
  const r1 = edgeActivationsFor('route', withErr)
  assert.equal(r1.get(withErr[0]), 'dead')
  assert.equal(r1.get(withErr[1]), 'active')
  const noErr = [e('1', 'a', 'b')]
  const r2 = edgeActivationsFor('route', noErr)
  assert.equal(r2.get(noErr[0]), 'active')
})

test('edgeActivationsFor: drop deads all outgoing', () => {
  const outs = [e('1', 'a', 'b'), e('2', 'a', 'c')]
  const acts = edgeActivationsFor('drop', outs)
  assert.equal(acts.get(outs[0]), 'dead')
  assert.equal(acts.get(outs[1]), 'dead')
})

test('findCycle detects a cycle and returns null for a DAG', () => {
  const out = new Map<string, FlowEdge[]>([
    ['a', [e('1', 'a', 'b')]],
    ['b', [e('2', 'b', 'c')]],
    ['c', []],
  ])
  assert.equal(findCycle(['a', 'b', 'c'], out), null)
  const cyc = new Map<string, FlowEdge[]>([
    ['a', [e('1', 'a', 'b')]],
    ['b', [e('2', 'b', 'a')]],
  ])
  assert.ok(findCycle(['a', 'b'], cyc))
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/dag-scheduler.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `dag-scheduler.ts`.**

Create `src/features/flows/dag-scheduler.ts`:

```ts
import type { FlowEdge } from '@/lib/flows/graph'

export type EdgeState = 'unresolved' | 'active' | 'dead'
export type NodeRunState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** The node-completion shapes the scheduler resolves edges for. */
export type EdgeResult = 'ok' | 'route' | 'drop' | 'skip' | { branch: string }

/**
 * Build incoming/outgoing edge indexes over the OUTER DAG — nodes inside a
 * loop/parallel body (`contained`) and any edge touching them are excluded, so
 * the scheduler treats each container as one node.
 */
export function buildAdjacency(
  nodes: { id: string }[],
  edges: FlowEdge[],
  contained: Set<string>,
): { incoming: Map<string, FlowEdge[]>; outgoing: Map<string, FlowEdge[]>; dagNodeIds: string[] } {
  const dagNodeIds = nodes.map((n) => n.id).filter((id) => !contained.has(id))
  const incoming = new Map<string, FlowEdge[]>()
  const outgoing = new Map<string, FlowEdge[]>()
  for (const id of dagNodeIds) {
    incoming.set(id, [])
    outgoing.set(id, [])
  }
  for (const edge of edges) {
    if (contained.has(edge.source) || contained.has(edge.target)) continue
    outgoing.get(edge.source)?.push(edge)
    incoming.get(edge.target)?.push(edge)
  }
  return { incoming, outgoing, dagNodeIds }
}

/**
 * The edge-resolution rules (spec §"Edge resolution on node completion"):
 * ok → activate non-error edges, dead error; branch → activate the chosen
 * branch, dead the rest; route → error edge if present else normal; drop →
 * dead all; skip (trigger/no-op) → activate all non-error edges.
 */
export function edgeActivationsFor(result: EdgeResult, outEdges: FlowEdge[]): Map<FlowEdge, 'active' | 'dead'> {
  const acts = new Map<FlowEdge, 'active' | 'dead'>()
  if (typeof result === 'object') {
    for (const edge of outEdges) acts.set(edge, edge.branch === result.branch ? 'active' : 'dead')
    return acts
  }
  if (result === 'drop') {
    for (const edge of outEdges) acts.set(edge, 'dead')
    return acts
  }
  if (result === 'route') {
    const errorEdge = outEdges.find((edge) => edge.branch === 'error')
    for (const edge of outEdges) acts.set(edge, errorEdge ? (edge === errorEdge ? 'active' : 'dead') : 'active')
    return acts
  }
  // ok / skip: fan out to every non-error edge, dead the error edge.
  for (const edge of outEdges) acts.set(edge, edge.branch === 'error' ? 'dead' : 'active')
  return acts
}

/** DFS cycle finder over the outer DAG; returns one offending node path or null. */
export function findCycle(dagNodeIds: string[], outgoing: Map<string, FlowEdge[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>(dagNodeIds.map((id) => [id, WHITE]))
  const stack: string[] = []
  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    for (const edge of outgoing.get(id) ?? []) {
      const next = edge.target
      if (!color.has(next)) continue
      if (color.get(next) === GRAY) return [...stack.slice(stack.indexOf(next)), next]
      if (color.get(next) === WHITE) {
        const found = dfs(next)
        if (found) return found
      }
    }
    color.set(id, BLACK)
    stack.pop()
    return null
  }
  for (const id of dagNodeIds) {
    if (color.get(id) === WHITE) {
      const found = dfs(id)
      if (found) return found
    }
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify pass.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/dag-scheduler.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit.**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add src/features/flows/dag-scheduler.ts src/features/flows/__tests__/dag-scheduler.test.ts
git commit -m "feat(flows): pure DAG adjacency/edge-resolution/cycle helpers"
```

---

### Task 3: Replace the walk with the scheduler

Swap the `while (current)` orchestration in `interpretFlow` for the dependency scheduler using the Task 2 helpers. This is the core change. The gate is the FULL existing `interpret.test.ts` (back-compat) — no new behavior yet beyond running the same graphs through the scheduler.

**Files:**
- Modify: `src/features/flows/interpret.ts` (replace ~lines 878–931, the block from `let lastOutput` / `let current` through the final `return done(...)`; add `MAX_CONCURRENT_NODES` constant and imports from `./dag-scheduler`)
- Test: `src/features/flows/__tests__/interpret.test.ts` (existing suite is the gate)

**Interfaces:**
- Consumes: `buildAdjacency`, `edgeActivationsFor`, `EdgeState`, `NodeRunState` from `./dag-scheduler`; existing `execNode`, `emitOutcome`, `outgoing`, `contained`, `byId`, `ctx`, `namedOutputs`, `done()`.
- Produces: unchanged `interpretFlow` return shape (`InterpretResult`).

- [ ] **Step 1: Baseline — run the full suite (must be green from Task 1).**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS.

- [ ] **Step 2: Add imports and the concurrency constant.**

At the top of `interpret.ts`, add to the existing `./context`/`./dag-scheduler` imports:

```ts
import { buildAdjacency, edgeActivationsFor, type EdgeState, type NodeRunState } from './dag-scheduler'
```

Near the other module constants (e.g. by `const sleep = ...`):

```ts
// Independent ready nodes run concurrently up to this bound. Matches the
// loop-node default; variable writes across concurrent branches are unordered.
const MAX_CONCURRENT_NODES = 8
```

- [ ] **Step 3: Replace the walk with the scheduler.**

Replace the entire block starting at `let lastOutput: unknown = input` and `let current: FlowNode | undefined = ...` through the final `return done({ status: 'succeeded', steps, output: lastOutput })` with:

```ts
  const { incoming, outgoing: outEdges, dagNodeIds } = buildAdjacency(graph.nodes, graph.edges, contained)
  const edgeState = new Map<FlowEdge, EdgeState>(graph.edges.map((edge) => [edge, 'unresolved' as EdgeState]))
  const nodeState = new Map<string, NodeRunState>(dagNodeIds.map((id) => [id, 'pending' as NodeRunState]))

  // Resume/replay: a node whose output was replayed (opts.completed) is already
  // `done`; re-run its edge resolution so downstream readiness matches the live
  // run. A previously-skipped node is restored from its persisted 'skipped'
  // step below (Task providing skippedNodeIds). Deterministic: condition/switch
  // re-evaluate to the same branch from the restored ctx.
  const resolveEdges = (id: string, result: Parameters<typeof edgeActivationsFor>[0]) => {
    const acts = edgeActivationsFor(result, outEdges.get(id) ?? [])
    for (const [edge, state] of acts) if (edgeState.get(edge) === 'unresolved') edgeState.set(edge, state)
  }

  const incomingResolved = (id: string) => (incoming.get(id) ?? []).every((edge) => edgeState.get(edge) !== 'unresolved')
  const hasActiveIncoming = (id: string) => (incoming.get(id) ?? []).some((edge) => edgeState.get(edge) === 'active')

  // Dead-path elimination: any pending node whose incoming edges are all
  // resolved with none active is skipped, and skipping deads its out-edges —
  // run to a fixpoint so the deadness cascades.
  const markSkipped = (id: string) => {
    nodeState.set(id, 'skipped')
    for (const edge of outEdges.get(id) ?? []) if (edgeState.get(edge) === 'unresolved') edgeState.set(edge, 'dead')
  }
  const propagateSkips = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const id of dagNodeIds) {
        if (nodeState.get(id) !== 'pending') continue
        if ((incoming.get(id) ?? []).length === 0) continue // a root is never skipped
        if (!incomingResolved(id) || hasActiveIncoming(id)) continue
        markSkipped(id)
        changed = true
      }
    }
  }

  let terminal: InterpretResult | null = null
  let lastOutput: unknown = input // filter-drop / no-sink back-compat output

  const runOne = async (node: FlowNode): Promise<void> => {
    nodeState.set(node.id, 'running')
    const res = await execNode(node, ctx)
    if (terminal) return // a sibling already ended the run; ignore late results
    if (res.kind === 'fail') { terminal = done({ status: 'failed', steps, output: lastOutput, error: res.error }); return }
    if (res.kind === 'pause') { terminal = done({ status: 'waiting', steps, output: lastOutput, waiting: { nodeId: res.nodeId, question: res.question } }); return }
    if (res.kind === 'stop') { nodeState.set(node.id, 'done'); terminal = done({ status: 'succeeded', steps, output: lastOutput }); return }
    if (res.kind === 'drop') { nodeState.set(node.id, 'skipped'); resolveEdges(node.id, 'drop'); return }
    if (res.kind === 'ok' || res.kind === 'route') lastOutput = res.output
    nodeState.set(node.id, 'done')
    resolveEdges(node.id, res.kind === 'branch' ? { branch: res.branch } : res.kind === 'route' ? 'route' : res.kind === 'skip' ? 'skip' : 'ok')
  }

  // The scheduler loop: skip dead paths, launch ready nodes up to the bound,
  // wait for one to finish, repeat until quiescent or a terminal signal.
  const running = new Set<Promise<void>>()
  const isRoot = (id: string) => (incoming.get(id) ?? []).length === 0
  const readyNodes = () =>
    dagNodeIds.filter((id) =>
      nodeState.get(id) === 'pending' && (isRoot(id) || (incomingResolved(id) && hasActiveIncoming(id))),
    )

  propagateSkips()
  while (!terminal) {
    const ready = readyNodes()
    if (ready.length === 0) {
      if (running.size === 0) break // quiescent — the run is done
      await Promise.race(running)
      propagateSkips()
      continue
    }
    for (const id of ready) {
      if (running.size >= MAX_CONCURRENT_NODES) break
      const node = byId.get(id)!
      const promise = runOne(node).finally(() => running.delete(promise))
      running.add(promise)
    }
    await Promise.race(running)
    propagateSkips()
  }
  await Promise.allSettled(running) // let any in-flight nodes settle before returning
  if (terminal) return terminal

  // Terminal output: named outputs win; else the sinks (done nodes with no
  // active out-edge). One sink → its output (linear back-compat); several →
  // aggregate by label; none → the last value carried into a dead end.
  const sinkOutputs: { label: string; output: unknown }[] = []
  for (const id of dagNodeIds) {
    if (nodeState.get(id) !== 'done') continue
    const hasActiveOut = (outEdges.get(id) ?? []).some((edge) => edgeState.get(edge) === 'active')
    if (hasActiveOut) continue
    const entry = ctx.step[id]
    if (entry !== undefined) sinkOutputs.push({ label: stepLabelMap[id] || id, output: entry.output })
  }
  let output: unknown = lastOutput
  if (sinkOutputs.length === 1) output = sinkOutputs[0].output
  else if (sinkOutputs.length > 1) output = Object.fromEntries(sinkOutputs.map((s) => [s.label, s.output]))
  return done({ status: 'succeeded', steps, output })
```

Note: `FlowEdge` is already imported at the top of `interpret.ts`; `stepLabelMap` is the id→label map built earlier in `interpretFlow`. Confirm both are in scope (they are — `stepLabelMap` was added when threading `stepLabels`).

- [ ] **Step 4: Run the full existing suite — every existing behavior must still hold.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS (all existing tests). If any fail, debug against that test's graph — the scheduler must reproduce linear/branch/loop/parallel/join/route behavior exactly. Do NOT weaken the tests.

- [ ] **Step 5: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/features/flows/interpret.ts
git commit -m "feat(flows): dependency scheduler replaces the single-path walk (behavior-preserving)"
```

---

### Task 4: DAG behavior — fan-in, dead-path, diamond, concurrency, multi-sink

Add the new DAG capabilities' test coverage. With Task 3's scheduler these should already work; this task proves them and fixes any gaps.

**Files:**
- Test: `src/features/flows/__tests__/interpret.test.ts` (append)
- Modify (only if a test fails): `src/features/flows/interpret.ts`

**Interfaces:**
- Consumes: `interpretFlow`, `stub`, `RunAgentFn`, `RunActionFn` (already imported in the test file).

- [ ] **Step 1: Write the DAG behavior tests.**

Append to `interpret.test.ts`:

```ts
test('DAG fan-in: three independent nodes converge on one agent, which runs once with all their data', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'c', type: 'agent', data: { agentId: 'c', input: 'x', label: 'C' } },
      { id: 'j', type: 'agent', data: { agentId: 'sink', input: '{{steps}}', label: 'Sink', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'trigger', target: 'c' },
      { id: 'e3', source: 'a', target: 'j' },
      { id: 'e4', source: 'b', target: 'j' },
      { id: 'e5', source: 'c', target: 'j' },
    ],
  }
  let runs = 0
  let sinkInput = ''
  const runAgent: RunAgentFn = async (node) => {
    if (node.agentId === 'sink') { runs++; sinkInput = node.input; return { output: 'merged' } }
    return { output: `${node.agentId.toUpperCase()}-out` }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(runs, 1, 'the fan-in node runs exactly once, after all parents')
  assert.ok(sinkInput.includes('A-out') && sinkInput.includes('B-out') && sinkInput.includes('C-out'), 'it sees every parents output via {{steps}}')
})

test('DAG dead-path: a condition gates two paths that both feed a join; only the taken side runs, join runs once', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'c', type: 'condition', data: { left: '{{trigger.input}}', op: 'eq', right: 'go' } },
      { id: 'hi', type: 'agent', data: { agentId: 'hi', input: 'x', label: 'Hi' } },
      { id: 'lo', type: 'agent', data: { agentId: 'lo', input: 'x', label: 'Lo' } },
      { id: 'j', type: 'join', data: {} },
      { id: 'end', type: 'agent', data: { agentId: 'end', input: 'x', label: 'End', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'c' },
      { id: 'e1', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e2', source: 'c', target: 'lo', branch: 'false' },
      { id: 'e3', source: 'hi', target: 'j' },
      { id: 'e4', source: 'lo', target: 'j' },
      { id: 'e5', source: 'j', target: 'end' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push(node.agentId); return { output: `${node.agentId}!` } }
  const result = await interpretFlow(graph, 'go', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.ok(seen.includes('hi') && seen.includes('end'), 'the taken branch and the join both run')
  assert.ok(!seen.includes('lo'), 'the dead branch never runs')
  assert.equal(seen.filter((s) => s === 'end').length, 1, 'the join-downstream node runs exactly once (no per-branch duplication)')
})

test('DAG concurrency: independent parents overlap in time, and the join waits for all', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'j', type: 'agent', data: { agentId: 'j', input: 'x', label: 'J', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  let active = 0, maxActive = 0, jStartedAfter = 0
  const doneParents = { count: 0 }
  const runAgent: RunAgentFn = async (node) => {
    if (node.agentId === 'j') { jStartedAfter = doneParents.count; return { output: 'j' } }
    active++; maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 20))
    active--; doneParents.count++
    return { output: node.agentId }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(maxActive, 2, 'a and b run concurrently')
  assert.equal(jStartedAfter, 2, 'j starts only after both parents finished')
})

test('DAG multi-sink: two terminal sinks aggregate by label; a single sink stays bare (back-compat)', async () => {
  const twoSinks: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'x', type: 'agent', data: { agentId: 'x', input: 'x', label: 'X' } },
      { id: 'y', type: 'agent', data: { agentId: 'y', input: 'x', label: 'Y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'x' },
      { id: 'e1', source: 'trigger', target: 'y' },
    ],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: `${node.agentId}-out` })
  const result = await interpretFlow(twoSinks, '', { runAgent })
  assert.deepEqual(result.output, { X: 'x-out', Y: 'y-out' })
})
```

- [ ] **Step 2: Run the DAG tests.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS. If concurrency or dead-path fails, fix in `interpret.ts` (scheduler), not the tests.

- [ ] **Step 3: Typecheck + commit.**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add src/features/flows/interpret.ts src/features/flows/__tests__/interpret.test.ts
git commit -m "test(flows): DAG fan-in, dead-path OR-join, concurrency, multi-sink"
```

---

### Task 5: Resume/replay across a DAG (skipped-node reconstruction)

Ensure a run paused mid-DAG resumes correctly: replayed `done` nodes re-resolve their edges, previously-`skipped` nodes restore their dead paths, and the scheduler drains the rest exactly once.

**Files:**
- Modify: `src/features/flows/interpret.ts` (the resume pre-marking block, before the scheduler loop; add `Opts.skippedNodeIds`)
- Modify: `src/features/flows/execute-flow.ts` (pass `skippedNodeIds` from persisted `skipped` step rows into `interpretFlow`)
- Test: `src/features/flows/__tests__/interpret.test.ts` (append)

**Interfaces:**
- Produces: `Opts` gains `skippedNodeIds?: Set<string>` — node ids that were dead-path-skipped on the prior run. `execute-flow.ts` builds it from `priorSteps` where `step.status === 'skipped'` (alongside the existing `completed` map).
- Consumes: existing `opts.completed` (nodeId → output), `resolveEdges`, `markSkipped`, `nodeState`.

- [ ] **Step 1: Write the resume test.**

Append to `interpret.test.ts`:

```ts
test('DAG resume: a diamond paused on one branch resumes and completes the rest exactly once', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'a', input: 'x', label: 'A' } },
      { id: 'b', type: 'agent', data: { agentId: 'b', input: 'x', label: 'B' } },
      { id: 'j', type: 'agent', data: { agentId: 'j', input: 'x', label: 'J', includeUpstreamContext: false } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  // Resume state: a and b already completed on the prior run; j is the one left.
  const runs: string[] = []
  const runAgent: RunAgentFn = async (node) => { runs.push(node.agentId); return { output: node.agentId } }
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { a: 'A-out', b: 'B-out' },
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(runs, ['j'], 'only the unfinished node runs; a and b are not re-executed')
})
```

- [ ] **Step 2: Run to confirm it fails (a/b re-run or j never becomes ready).**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: the resume test FAILS (the existing `completed` handling skips re-execution but the scheduler's edge state isn't primed, so `j`'s incoming never resolve). Confirm the failure mode, then fix.

- [ ] **Step 3: Prime scheduler state from `completed` + `skippedNodeIds`.**

Add `skippedNodeIds?: Set<string>` to the `Opts` type. Immediately BEFORE `propagateSkips()` (the first call, before the scheduler loop), insert the reconstruction:

```ts
  // Resume: pre-mark nodes settled on the prior run so the scheduler resumes
  // mid-DAG. A replayed `done` node re-resolves its edges (deterministic:
  // condition/switch re-evaluate to the same branch from restored ctx); a
  // prior `skipped` node restores its dead out-edges. Everything else stays
  // pending and the scheduler drains it.
  if (opts.completed || opts.skippedNodeIds) {
    // Re-resolve in recorded order so branch choices and deadness cascade the
    // same way they did live. `completed` preserves order (execute-flow builds
    // it from step rows ordered `order asc`).
    for (const id of Object.keys(opts.completed ?? {})) {
      if (!nodeState.has(id)) continue
      nodeState.set(id, 'done')
      const node = byId.get(id)
      if (node?.type === 'condition') {
        resolveEdges(id, { branch: evalCondition(node.data, ctx) ? 'true' : 'false' })
      } else if (node?.type === 'switch') {
        const hit = node.data.cases.find((c) => evalClause({ left: c.left, op: c.op, right: c.right }, ctx))
        resolveEdges(id, { branch: hit ? hit.id : 'default' })
      } else if (opts.completedRoutes?.has(id)) {
        resolveEdges(id, 'route')
      } else {
        resolveEdges(id, 'ok')
      }
    }
    for (const id of opts.skippedNodeIds ?? []) {
      if (nodeState.get(id) === 'pending') markSkipped(id)
    }
  }
```

(Note: `ctx.step` is already rebuilt from `completed` by `execNode`'s completed-map handling when those nodes would run — but on resume they DON'T run, so also ensure `ctx.step[id]` is seeded. If `ctx.step` isn't already primed from `completed` before the scheduler, seed it here: `ctx.step[id] = { output: opts.completed[id] }` inside the loop, before re-resolving edges. Verify against the failing test.)

- [ ] **Step 4: Seed `ctx.step` from `completed` for resumed nodes.**

Inside the `for (const id of Object.keys(opts.completed ?? {}))` loop, as the FIRST line of the body:

```ts
      ctx.step[id] = { output: opts.completed![id] }
```

- [ ] **Step 5: Run the resume test.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/interpret.test.ts`
Expected: PASS (resume runs only `j`), and all prior tests still green.

- [ ] **Step 6: Wire `skippedNodeIds` from `execute-flow.ts`.**

In `execute-flow.ts`, where the resume `completed`/`completedRoutes` maps are built from `priorSteps`, also collect skipped ids and pass them:

```ts
  const skippedNodeIds = new Set<string>()
  // ... inside the priorSteps loop:
  if (step.status === 'skipped') skippedNodeIds.add(step.nodeId)
  // ... in the interpretFlow opts:
  ...(resuming || replaySource ? { completed, completedRoutes, skippedNodeIds } : {}),
```

- [ ] **Step 7: Typecheck + commit.**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add src/features/flows/interpret.ts src/features/flows/execute-flow.ts src/features/flows/__tests__/interpret.test.ts
git commit -m "feat(flows): resume a DAG mid-run — reconstruct done/skipped state and drain the rest"
```

---

### Task 6: Validation — cycles rejected, multi-incoming allowed, back-edges flagged

Add cycle detection and confirm multi-incoming graphs validate. A back-looping `error` edge (previously legal) is now a `CYCLE` error pointing users at `retries`.

**Files:**
- Modify: `src/lib/flows/validate.ts` (add a cycle check using `findCycle`)
- Test: `src/lib/flows/__tests__/validate.test.ts` (append)

**Interfaces:**
- Consumes: `findCycle`, `buildAdjacency` from `@/features/flows/dag-scheduler`; existing `add(issues, 'error', code, message, nodeId?)` helper and `FlowValidationIssue`.
- Produces: a new issue code `'CYCLE'`.

- [ ] **Step 1: Write the validation tests.**

Append to `validate.test.ts` (match the file's existing import/style):

```ts
test('a graph with a cycle is rejected with CYCLE', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' }, // back-edge → cycle
    ],
  }
  const result = validateFlowGraph(graph as never, { agents: [{ id: 'x', title: 'X' }], toolCatalog: [], flowId: 'f' })
  assert.ok(!result.ok)
  assert.ok(result.issues.some((i) => i.code === 'CYCLE'))
})

test('a multi-incoming (fan-in) graph is valid', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'x' } },
      { id: 'j', type: 'agent', data: { agentId: 'x', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
      { id: 'e2', source: 'a', target: 'j' },
      { id: 'e3', source: 'b', target: 'j' },
    ],
  }
  const result = validateFlowGraph(graph as never, { agents: [{ id: 'x', title: 'X' }], toolCatalog: [], flowId: 'f' })
  assert.ok(result.ok, JSON.stringify(result.issues))
})
```

- [ ] **Step 2: Run to confirm the cycle test fails (no CYCLE yet).**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/validate.test.ts`
Expected: the cycle test FAILS (currently no cycle detection); the fan-in test may already pass.

- [ ] **Step 3: Add cycle detection to `validate.ts`.**

Add the import at the top:

```ts
import { buildAdjacency, findCycle } from '@/features/flows/dag-scheduler'
```

Inside `validateFlowGraph`, after the dangling-edge checks and near the reachability check, add:

```ts
  // Cycle check: the outer DAG (container bodies excluded) must be acyclic —
  // the scheduler would deadlock on a back-edge. Retry loops belong in a node's
  // `retries` field, not a back-looping error edge.
  const containerMembers = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )
  const { outgoing, dagNodeIds } = buildAdjacency(graph.nodes, graph.edges, containerMembers)
  const cycle = findCycle(dagNodeIds, outgoing)
  if (cycle) {
    add(issues, 'error', 'CYCLE', `These steps form a loop (${cycle.join(' → ')}). Flows must run forward — for retries, set a step's retry count instead of looping an edge back.`, cycle[0])
  }
```

- [ ] **Step 4: Run the validation tests.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/validate.test.ts`
Expected: PASS (cycle rejected, fan-in valid), and all existing validate tests still pass.

- [ ] **Step 5: Typecheck + commit.**

Run: `npx tsc --noEmit` (clean), then:

```bash
git add src/lib/flows/validate.ts src/lib/flows/__tests__/validate.test.ts
git commit -m "feat(flows): reject cyclic graphs (CYCLE); allow multi-incoming fan-in"
```

---

### Task 7: Copilot grounding + full verification gate

Teach the flow copilot it may now emit fan-in graphs and must keep them acyclic, then run every gate.

**Files:**
- Modify: `src/lib/flows/copilot-grounding.ts`
- (No new tests; runs the whole suite + build.)

- [ ] **Step 1: Update copilot grounding.**

In `copilot-grounding.ts`, add a sentence to the grounding string (near the edges/topology guidance):

```ts
  'Flows are directed ACYCLIC graphs: a step may have multiple incoming edges (fan-in) — it runs once, after every incoming path resolves, and can read each parent via {{step.<id>.output}} or the {{steps}} aggregate. Several independent steps (e.g. query-API calls) can run in parallel and fan into one agent. Never create a cycle (an edge that loops back); for retries set a step\'s retry count. Condition/Switch branches that are not taken are pruned, so a join after them runs once with whichever branch ran. ' +
```

- [ ] **Step 2: Typecheck + lint.**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (0 errors — pre-existing warnings in unrelated files are acceptable).

- [ ] **Step 3: Full unit suite.**

Run: `npm test`
Expected: PASS (no failures).

- [ ] **Step 4: CI-mode suite against `ci_repro` + build.**

Recreate/deploy the throwaway DB and run the DB-backed suite and build (commands per `docs/superpowers/plans/2026-07-10-remediation-ws2-flow-durability-parity.md`):

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ci_repro' -c 'CREATE DATABASE ci_repro'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm test
TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ci_repro ENCRYPTION_KEY=ci-encryption-key NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder npm run build
```

Expected: all tests pass; build succeeds.

- [ ] **Step 5: Commit + push.**

```bash
git add src/lib/flows/copilot-grounding.ts
git commit -m "feat(flows): copilot may emit acyclic fan-in graphs"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Node/edge state machine → Task 2 (`EdgeState`/`NodeRunState`, `buildAdjacency`), Task 3 (state maps).
- Edge resolution table → Task 2 (`edgeActivationsFor`), Task 3 (`resolveEdges`).
- Readiness / dead-path OR-join → Task 3 (`propagateSkips`, `readyNodes`), Task 4 (dead-path test).
- Condition/Switch as `branch` → Task 1.
- Concurrency (bound 8) → Task 3 (scheduler loop, `MAX_CONCURRENT_NODES`), Task 4 (concurrency test).
- Containers unchanged → Task 2/3 (`contained` excluded from the DAG).
- `join` aggregate output → covered by multi-active-parent aggregate in Task 3's sink logic + the existing join passthrough (the join node itself still runs via `execNode`).
- Termination / multi-sink output → Task 3, Task 4 (multi-sink test).
- Failure/pause/stop → Task 3 (`runOne`).
- Resume/replay → Task 5.
- Validation cycle/multi-incoming/back-edge → Task 6.
- Copilot grounding → Task 7.

**Placeholder scan:** No TBD/TODO; all code steps show code; commands have expected output. The one conditional instruction (Task 5 Step 3 note about seeding `ctx.step`) is resolved concretely in Step 4.

**Type consistency:** `EdgeResult`/`edgeActivationsFor` signature matches its calls in Task 3 (`resolveEdges` passes `'ok'|'route'|'drop'|'skip'|{branch}`). `NodeResult.branch` (Task 1) is consumed by Task 3's `runOne`. `Opts.skippedNodeIds` (Task 5) matches the `execute-flow.ts` wiring. `findCycle(dagNodeIds, outgoing)` signature matches Task 6's call.

**Open items:** The `join` node's multi-active-parent aggregate output is delivered by Task 3's sink aggregation only when the join is a sink; if a join has downstream nodes, its own `execNode` output (today: `lastOutput` passthrough) still flows. If richer join-merge output is wanted mid-graph, that's a small follow-up — not required for the fan-in-into-agent scenario, which reads parents via `{{steps}}`.
