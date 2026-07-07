# Flows — Visual Agent Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Flows" — a first-class, deterministic, visual agent-pipeline builder modelled on the Workato recipe builder, where each step runs a workspace agent via the existing `runAgentExecution` runtime.

**Architecture:** A pure graph interpreter (`interpret.ts`) drives traversal/branch/loop/parallel logic and is fully unit-testable with a stubbed agent runner. A prisma-backed orchestrator (`execute-flow.ts`) wraps it, creating `FlowRun`/`FlowRunStep` rows and calling `runAgentExecution` per agent node. API routes mirror `/api/agents`. The builder UI (`/flows/[id]`) renders a vertical canvas + config drawer + copilot panel.

**Tech Stack:** Next.js App Router, Prisma/Postgres, TypeScript, `tsx --test` (node:test) for logic tests, Tailwind, existing UI primitives, Anthropic-wire LLM via `generateStructured`.

## Global Constraints

- Tests live in `__tests__/*.test.ts` and run via `npm test` (`tsx --test` over `*__tests__*`). Verify with `npm run typecheck && npm run lint && npm test`. Local build lacks Supabase env by design — never rely on `npm run dev`/`build` locally; Vercel validates builds.
- Default model constant: `DEFAULT_AGENT_MODEL` from `@/lib/llm/model-runner` (currently `claude-sonnet-5`). Never hardcode a model string.
- All API routes use `withAuthenticatedApi` from `@/lib/server/api-handler`; scope reads with `agentVisibilityScope(auth.dbUser.id)` from `@/lib/server/visibility` and always filter by `organizationId: auth.organizationId`.
- Model/user-facing name is **Flow**; DB tables are `flows`, `flow_runs`, `flow_run_steps`. Do not reuse the existing `WorkflowStep`/`WorkflowEvent` models (those are per-agent execution traces).
- Migrations are applied in prod via `prisma migrate deploy` (baselined). Add a new timestamped folder under `prisma/migrations/` with a hand-written `migration.sql`; do not run `migrate dev` against prod.
- `runAgentExecution(job)` returns `{ summary: string }` on completion, or `{ status: 'waiting_for_input'|'waiting_for_approval', question?, approvalId? }` when paused, or `{ status, skipped: true }` if already terminal. Treat only `{ summary }` as success.
- No JS `eval`. Input templates are `{{...}}` token substitution over a dot-path accessor; conditions are structured `{left, op, right}`.

---

## File structure

- `src/features/flows/context.ts` — pure: template resolver, dot-path reader, condition evaluator, `asStructured`.
- `src/features/flows/interpret.ts` — pure graph interpreter (traversal, agent/condition/loop/parallel, guards). No prisma.
- `src/features/flows/execute-flow.ts` — prisma-backed orchestrator: `runFlowExecution`, `FlowExecutionJob`, adapter to `runAgentExecution` + `FlowRunStep` writes.
- `src/lib/flows/graph.ts` — zod schemas + TS types for `FlowGraph`, nodes, edges, condition ops (shared by API + interpreter + UI).
- `src/lib/flows/serialize.ts` — `serializeFlow(row)` wire shape.
- `src/app/api/flows/route.ts` — CRUD.
- `src/app/api/flows/[id]/execute/route.ts` — manual run.
- `src/app/api/flows/[id]/runs/route.ts` — run history + latest run's steps (live status).
- `src/app/api/flows/copilot/route.ts` — description → draft graph.
- `src/app/api/cron/dispatch/route.ts` — MODIFY: also enqueue scheduled flows.
- `src/components/layout/sidebar.tsx` — MODIFY: add "Flows" nav entry.
- `src/app/flows/page.tsx` — flow list.
- `src/app/flows/[id]/page.tsx` — builder (canvas + drawer + copilot + live status).
- `src/components/flows/*` — builder subcomponents (canvas, step card, config drawer, copilot panel).

---

## Task 1: Prisma models + migration

**Files:**
- Modify: `prisma/schema.prisma` (add three models; add `FlowRun[]`/`FlowRunStep[]` relations only on the new models)
- Create: `prisma/migrations/20260707120000_flows/migration.sql`

**Interfaces:**
- Produces: prisma models `Flow`, `FlowRun`, `FlowRunStep` (fields exactly as in the spec's Data model section); tables `flows`, `flow_runs`, `flow_run_steps`.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`** (append near the other domain models, before the enums)

```prisma
model Flow {
  id             String    @id @default(cuid())
  name           String
  description    String    @default("")
  status         String    @default("DRAFT")
  trigger        Json      @default("{}")
  graph          Json      @default("{}")
  visibility     String    @default("shared")
  organizationId String
  userId         String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  runs           FlowRun[]

  @@index([organizationId, updatedAt])
  @@map("flows")
}

model FlowRun {
  id             String        @id @default(cuid())
  flowId         String
  status         String        @default("running")
  trigger        Json          @default("{}")
  input          Json          @default("{}")
  output         Json?
  error          String?
  startedAt      DateTime      @default(now())
  finishedAt     DateTime?
  organizationId String
  userId         String?
  flow           Flow          @relation(fields: [flowId], references: [id], onDelete: Cascade)
  steps          FlowRunStep[]

  @@index([flowId, startedAt])
  @@map("flow_runs")
}

model FlowRunStep {
  id               String    @id @default(cuid())
  flowRunId        String
  nodeId           String
  agentExecutionId String?
  order            Int       @default(0)
  status           String    @default("queued")
  input            Json      @default("{}")
  output           Json?
  error            String?
  startedAt        DateTime?
  finishedAt       DateTime?
  run              FlowRun   @relation(fields: [flowRunId], references: [id], onDelete: Cascade)

  @@index([flowRunId, order])
  @@map("flow_run_steps")
}
```

- [ ] **Step 2: Write the migration SQL** at `prisma/migrations/20260707120000_flows/migration.sql`

```sql
-- CreateTable
CREATE TABLE "flows" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "graph" JSONB NOT NULL DEFAULT '{}',
  "visibility" TEXT NOT NULL DEFAULT 'shared',
  "organizationId" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_runs" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "organizationId" TEXT NOT NULL,
  "userId" TEXT,
  CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_run_steps" (
  "id" TEXT NOT NULL,
  "flowRunId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "agentExecutionId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "flow_run_steps_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "flows_organizationId_updatedAt_idx" ON "flows"("organizationId", "updatedAt");
CREATE INDEX "flow_runs_flowId_startedAt_idx" ON "flow_runs"("flowId", "startedAt");
CREATE INDEX "flow_run_steps_flowRunId_order_idx" ON "flow_run_steps"("flowRunId", "order");

-- Foreign keys
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_flowRunId_fkey"
  FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the client + typecheck**

Run: `npm run typecheck`
Expected: PASS (0 `error TS`). `prisma generate` runs first and now knows `prisma.flow`, `prisma.flowRun`, `prisma.flowRunStep`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260707120000_flows
git commit -m "feat(flows): add Flow/FlowRun/FlowRunStep models + migration"
```

---

## Task 2: Graph schema + types (`src/lib/flows/graph.ts`)

**Files:**
- Create: `src/lib/flows/graph.ts`
- Test: `src/lib/flows/__tests__/graph.test.ts`

**Interfaces:**
- Produces: `ConditionOp` (`'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'contains'|'matches'`); TS types `FlowNode`, `FlowEdge`, `FlowGraph`; zod `flowGraphSchema` that parses/validates a graph; `emptyGraph()` returning `{ nodes: [{ id:'trigger', type:'trigger', data:{ trigger:{ type:'manual' } } }], edges: [] }`.

- [ ] **Step 1: Write the failing test** `src/lib/flows/__tests__/graph.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('emptyGraph has a single manual trigger node and no edges', () => {
  const g = emptyGraph()
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].type, 'trigger')
  assert.deepEqual(g.edges, [])
})

test('flowGraphSchema accepts a valid agent+condition graph', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'condition', data: { left: '{{step.n1.output}}', op: 'contains', right: 'yes' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  assert.equal(parsed.nodes.length, 3)
})

test('flowGraphSchema rejects an unknown node type', () => {
  assert.throws(() => flowGraphSchema.parse({ nodes: [{ id: 'x', type: 'webhook', data: {} }], edges: [] }))
})

test('flowGraphSchema rejects a condition with a bad op', () => {
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [{ id: 'c', type: 'condition', data: { left: 'a', op: 'startsWith', right: 'b' } }],
      edges: [],
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test 2>&1 | grep graph.test` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/flows/graph.ts`**

```ts
import { z } from 'zod'

export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

const triggerNode = z.object({ id: z.string(), type: z.literal('trigger'), data: z.object({ trigger: z.any().optional() }) })
const agentNode = z.object({
  id: z.string(),
  type: z.literal('agent'),
  data: z.object({
    agentId: z.string(),
    label: z.string().optional(),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
  }),
})
const conditionNode = z.object({
  id: z.string(),
  type: z.literal('condition'),
  data: z.object({ label: z.string().optional(), left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() }),
})
const loopNode = z.object({
  id: z.string(),
  type: z.literal('loop'),
  data: z.object({ label: z.string().optional(), over: z.string(), concurrency: z.number().int().min(1).max(20).optional(), body: z.array(z.string()) }),
})
const parallelNode = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  data: z.object({ label: z.string().optional(), branches: z.array(z.array(z.string())) }),
})

export const flowNodeSchema = z.discriminatedUnion('type', [triggerNode, agentNode, conditionNode, loopNode, parallelNode])
export const flowEdgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string(), branch: z.enum(['true', 'false']).optional() })
export const flowGraphSchema = z.object({ nodes: z.array(flowNodeSchema), edges: z.array(flowEdgeSchema) })

export type FlowNode = z.infer<typeof flowNodeSchema>
export type FlowEdge = z.infer<typeof flowEdgeSchema>
export type FlowGraph = z.infer<typeof flowGraphSchema>

export function emptyGraph(): FlowGraph {
  return { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] }
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test 2>&1 | grep -E "graph.test|# (pass|fail)"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/graph.ts src/lib/flows/__tests__/graph.test.ts
git commit -m "feat(flows): graph schema + node/edge types"
```

---

## Task 3: Context — template resolver + condition evaluator (`src/features/flows/context.ts`)

**Files:**
- Create: `src/features/flows/context.ts`
- Test: `src/features/flows/__tests__/context.test.ts`

**Interfaces:**
- Consumes: `ConditionOp` from `@/lib/flows/graph`.
- Produces:
  - `type FlowContext = { trigger: { input: unknown }; step: Record<string, { output: unknown }>; item?: unknown }`
  - `readPath(ctx: FlowContext, path: string): unknown` — dot-path over the context (e.g. `trigger.input`, `step.n1.output.score`, `item`).
  - `resolveTemplate(template: string, ctx: FlowContext): string` — replaces `{{path}}` tokens; objects are JSON-stringified, `null`/`undefined` → `''`.
  - `asStructured(output: unknown): unknown` — if a string that `JSON.parse`s to an object/array, return parsed; else return the value unchanged.
  - `evalCondition(cond: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean`.

- [ ] **Step 1: Write the failing test** `src/features/flows/__tests__/context.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPath, resolveTemplate, asStructured, evalCondition, type FlowContext } from '../context'

const ctx: FlowContext = {
  trigger: { input: 'Acme, Globex' },
  step: { n1: { output: '["Acme","Globex"]' }, n3: { output: { score: 91 } } },
  item: 'Acme',
}

test('readPath reads trigger, nested step output, and item', () => {
  assert.equal(readPath(ctx, 'trigger.input'), 'Acme, Globex')
  assert.equal(readPath(ctx, 'step.n3.output.score'), 91)
  assert.equal(readPath(ctx, 'item'), 'Acme')
  assert.equal(readPath(ctx, 'step.nope.output'), undefined)
})

test('resolveTemplate substitutes tokens; missing → empty; objects → JSON', () => {
  assert.equal(resolveTemplate('Score {{item}}', ctx), 'Score Acme')
  assert.equal(resolveTemplate('{{step.n3.output}}', ctx), '{"score":91}')
  assert.equal(resolveTemplate('x{{step.missing.output}}y', ctx), 'xy')
})

test('asStructured parses JSON strings, passes through non-JSON', () => {
  assert.deepEqual(asStructured('["a","b"]'), ['a', 'b'])
  assert.equal(asStructured('hello'), 'hello')
  assert.deepEqual(asStructured({ a: 1 }), { a: 1 })
})

test('evalCondition handles numeric and string ops', () => {
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'gt', right: '80' }, ctx), true)
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'lt', right: '80' }, ctx), false)
  assert.equal(evalCondition({ left: '{{trigger.input}}', op: 'contains', right: 'Globex' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'eq', right: 'Acme' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'matches', right: '^Ac' }, ctx), true)
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test 2>&1 | grep context.test` → FAIL.

- [ ] **Step 3: Implement `src/features/flows/context.ts`**

```ts
import type { ConditionOp } from '@/lib/flows/graph'

export type FlowContext = {
  trigger: { input: unknown }
  step: Record<string, { output: unknown }>
  item?: unknown
}

export function readPath(ctx: FlowContext, path: string): unknown {
  const parts = path.trim().split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

export function resolveTemplate(template: string, ctx: FlowContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(ctx, path)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

export function asStructured(output: unknown): unknown {
  if (typeof output !== 'string') return output
  const trimmed = output.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return output
  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

function coerce(value: string): number | string {
  const n = Number(value)
  return value.trim() !== '' && !Number.isNaN(n) ? n : value
}

export function evalCondition(cond: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean {
  const leftRaw = resolveTemplate(cond.left, ctx)
  const rightRaw = cond.right
  switch (cond.op) {
    case 'contains':
      return leftRaw.includes(rightRaw)
    case 'matches':
      try {
        return new RegExp(rightRaw).test(leftRaw)
      } catch {
        return false
      }
    default: {
      const l = coerce(leftRaw)
      const r = coerce(rightRaw)
      switch (cond.op) {
        case 'eq':
          return l === r
        case 'neq':
          return l !== r
        case 'gt':
          return l > r
        case 'gte':
          return l >= r
        case 'lt':
          return l < r
        case 'lte':
          return l <= r
      }
    }
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test 2>&1 | grep -E "context.test|# (pass|fail)"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/flows/context.ts src/features/flows/__tests__/context.test.ts
git commit -m "feat(flows): template resolver + structured condition evaluator"
```

---

## Task 4: Pure graph interpreter (`src/features/flows/interpret.ts`)

**Files:**
- Create: `src/features/flows/interpret.ts`
- Test: `src/features/flows/__tests__/interpret.test.ts`

**Interfaces:**
- Consumes: `FlowGraph`, `FlowNode`, `FlowEdge` from `@/lib/flows/graph`; `FlowContext`, `resolveTemplate`, `asStructured`, `evalCondition` from `./context`.
- Produces:
  - `type StepOutcome = { nodeId: string; status: 'succeeded'|'failed'|'skipped'|'waiting'; output?: unknown; error?: string }`
  - `type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }`
  - `type RunAgentFn = (node: { id: string; agentId: string; input: string }) => Promise<RunAgentResult>`
  - `type InterpretResult = { status: 'succeeded'|'failed'|'waiting'; steps: StepOutcome[]; output: unknown; waiting?: { nodeId: string; question?: string } }`
  - `async function interpretFlow(graph: FlowGraph, input: unknown, opts: { runAgent: RunAgentFn; maxSteps?: number; maxLoopIterations?: number; onStep?: (o: StepOutcome) => void }): Promise<InterpretResult>`

**Interpreter rules (implement exactly):**
- Start at the `trigger` node; `context.trigger.input = input`.
- "Next node" = follow the single outgoing edge from the current node. For a `condition` node, follow the edge whose `branch` matches the evaluated boolean (`'true'`/`'false'`); if none, the flow ends.
- `agent` node: `input = resolveTemplate(data.input ?? '{{trigger.input}}', context)`; call `runAgent`. On `waiting`, stop with `status:'waiting'`. On `error`: if `onError==='continue'`, record `failed` outcome and continue; else stop with `status:'failed'`. On success, `context.step[id] = { output: asStructured(result.output) }`.
- `loop` node: `list = asStructured(resolveTemplate(data.over, context))`; must be an array (else treat as empty). For each item (bounded by `maxLoopIterations`), run the `body` node ids in sequence with `context.item = item`, collecting each body's terminal output; the loop's own output = array of per-item results. Concurrency: run up to `data.concurrency ?? 1` items at once. Body agent nodes read `{{item}}`.
- `parallel` node: run each branch (array of node ids) concurrently; output = `{ [firstNodeIdOfBranch]: branchOutput }`. Merge, then continue from the parallel node's outgoing edge.
- Global `maxSteps` (default 100) counts every node visit; exceeding it stops with `status:'failed'`, error `'flow exceeded max steps'`.
- Final `output` = the last successful node's output.
- Call `opts.onStep(outcome)` after each agent-node outcome (for live persistence).

- [ ] **Step 1: Write the failing test** `src/features/flows/__tests__/interpret.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// A runAgent stub that echoes a canned output per agentId.
const stub = (map: Record<string, unknown>): RunAgentFn => async (node) => ({ output: map[node.agentId] ?? `ran:${node.input}` })

test('linear flow threads output between two agent steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.n1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: stub({ a1: 'ONE' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got ONE')
  assert.equal(result.steps.filter((s) => s.status === 'succeeded').length, 2)
})

test('condition routes to the true branch', async () => {
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

test('loop fans out over an array and collects results', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'loop', type: 'loop', data: { over: '{{step.list.output}}', concurrency: 2, body: ['score'] } },
      { id: 'score', type: 'agent', data: { agentId: 'score', input: 'score {{item}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'loop' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["A","B","C"]' }) })
  assert.deepEqual(result.output, ['score A', 'score B', 'score C'])
})

test('waiting sub-run halts the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'ask', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_for_input', question: 'Which segment?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.question, 'Which segment?')
})

test('onError:stop fails the flow; onError:continue proceeds', async () => {
  const base = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'boom', input: 'x', onError } },
      { id: 'n2', type: 'agent', data: { agentId: 'ok', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: 'DONE' })
  assert.equal((await interpretFlow(base('stop'), '', { runAgent })).status, 'failed')
  assert.equal((await interpretFlow(base('continue'), '', { runAgent })).output, 'DONE')
})
```

- [ ] **Step 2: Run test to verify it fails** — Run: `npm test 2>&1 | grep interpret.test` → FAIL.

- [ ] **Step 3: Implement `src/features/flows/interpret.ts`** (complete the interpreter per the rules above)

```ts
import type { FlowGraph, FlowNode, FlowEdge } from '@/lib/flows/graph'
import { resolveTemplate, asStructured, evalCondition, type FlowContext } from './context'

export type StepOutcome = { nodeId: string; status: 'succeeded' | 'failed' | 'skipped' | 'waiting'; output?: unknown; error?: string }
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunAgentFn = (node: { id: string; agentId: string; input: string }) => Promise<RunAgentResult>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting'
  steps: StepOutcome[]
  output: unknown
  waiting?: { nodeId: string; question?: string }
}

type Opts = { runAgent: RunAgentFn; maxSteps?: number; maxLoopIterations?: number; onStep?: (o: StepOutcome) => void }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function interpretFlow(graph: FlowGraph, input: unknown, opts: Opts): Promise<InterpretResult> {
  const maxSteps = opts.maxSteps ?? 100
  const maxLoop = opts.maxLoopIterations ?? 500
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const outgoing = (id: string, branch?: 'true' | 'false'): FlowEdge | undefined =>
    graph.edges.find((e) => e.source === id && (branch === undefined || e.branch === branch || e.branch === undefined))
  const ctx: FlowContext = { trigger: { input }, step: {} }
  const steps: StepOutcome[] = []
  let visits = 0
  let lastOutput: unknown = input

  // Runs one node in `ctx`; returns its output, or a control signal.
  async function runNode(node: FlowNode): Promise<{ output?: unknown; halt?: InterpretResult }> {
    if (++visits > maxSteps) {
      return { halt: { status: 'failed', steps, output: lastOutput, waiting: undefined } }
    }
    if (node.type === 'agent') {
      const resolved = resolveTemplate(node.data.input ?? '{{trigger.input}}', ctx)
      const res = await opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolved })
      if (res.waiting) {
        const outcome: StepOutcome = { nodeId: node.id, status: 'waiting' }
        steps.push(outcome); opts.onStep?.(outcome)
        return { halt: { status: 'waiting', steps, output: lastOutput, waiting: { nodeId: node.id, question: res.waiting.question } } }
      }
      if (res.error) {
        const outcome: StepOutcome = { nodeId: node.id, status: 'failed', error: res.error }
        steps.push(outcome); opts.onStep?.(outcome)
        if ((node.data.onError ?? 'stop') === 'stop') return { halt: { status: 'failed', steps, output: lastOutput } }
        return { output: undefined }
      }
      const output = asStructured(res.output)
      ctx.step[node.id] = { output }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output }
      steps.push(outcome); opts.onStep?.(outcome)
      return { output }
    }
    if (node.type === 'loop') {
      const list = asStructured(resolveTemplate(node.data.over, ctx))
      const items = Array.isArray(list) ? list.slice(0, maxLoop) : []
      const bodyNodes = node.data.body.map((id) => byId.get(id)).filter(Boolean) as FlowNode[]
      const perItem = await mapLimit(items, node.data.concurrency ?? 1, async (item) => {
        const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item }
        let out: unknown = item
        for (const bn of bodyNodes) {
          if (bn.type !== 'agent') continue
          const resolved = resolveTemplate(bn.data.input ?? '{{item}}', branchCtx)
          const res = await opts.runAgent({ id: bn.id, agentId: bn.data.agentId, input: resolved })
          if (res.error) { out = undefined; break }
          out = asStructured(res.output)
          branchCtx.step[bn.id] = { output: out }
        }
        return out
      })
      ctx.step[node.id] = { output: perItem }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output: perItem }
      steps.push(outcome); opts.onStep?.(outcome)
      return { output: perItem }
    }
    if (node.type === 'parallel') {
      const branchOutputs = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step } }
          let out: unknown
          for (const id of branch) {
            const bn = byId.get(id)
            if (!bn || bn.type !== 'agent') continue
            const resolved = resolveTemplate(bn.data.input ?? '{{trigger.input}}', branchCtx)
            const res = await opts.runAgent({ id: bn.id, agentId: bn.data.agentId, input: resolved })
            if (res.error) { out = undefined; break }
            out = asStructured(res.output)
            branchCtx.step[bn.id] = { output: out }
          }
          return [branch[0] ?? node.id, out] as const
        }),
      )
      const merged = Object.fromEntries(branchOutputs)
      ctx.step[node.id] = { output: merged }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output: merged }
      steps.push(outcome); opts.onStep?.(outcome)
      return { output: merged }
    }
    return { output: undefined } // trigger
  }

  // Drive the main chain.
  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  const bodyNodeIds = new Set(graph.nodes.flatMap((n) => (n.type === 'loop' ? n.data.body : n.type === 'parallel' ? n.data.branches.flat() : [])))
  while (current) {
    if (current.type === 'condition') {
      if (++visits > maxSteps) return { status: 'failed', steps, output: lastOutput }
      const branch = evalCondition(current.data, ctx) ? 'true' : 'false'
      const edge = outgoing(current.id, branch)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }
    if (current.type !== 'trigger') {
      const { output, halt } = await runNode(current)
      if (halt) return halt
      if (output !== undefined) lastOutput = output
    }
    const edge = outgoing(current.id)
    // Never fall into loop/parallel body nodes from the main chain.
    let next = edge ? byId.get(edge.target) : undefined
    while (next && bodyNodeIds.has(next.id)) {
      const skip = outgoing(next.id)
      next = skip ? byId.get(skip.target) : undefined
    }
    current = next
  }
  return { status: 'succeeded', steps, output: lastOutput }
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npm test 2>&1 | grep -E "interpret.test|# (pass|fail)"` → PASS (all interpret cases + total count up).

- [ ] **Step 5: Commit**

```bash
git add src/features/flows/interpret.ts src/features/flows/__tests__/interpret.test.ts
git commit -m "feat(flows): pure graph interpreter (agent/condition/loop/parallel)"
```

---

## Task 5: Prisma-backed orchestrator (`src/features/flows/execute-flow.ts`)

**Files:**
- Create: `src/features/flows/execute-flow.ts`

**Interfaces:**
- Consumes: `interpretFlow`, `RunAgentFn` from `./interpret`; `flowGraphSchema` from `@/lib/flows/graph`; `runAgentExecution` from `@/features/agents/execute-agent`; `prisma`.
- Produces:
  - `type FlowExecutionJob = { flowId: string; organizationId: string; userId: string; input?: string; flowRunId?: string }`
  - `async function runFlowExecution(job: FlowExecutionJob): Promise<{ flowRunId: string; status: string; output: unknown }>`

- [ ] **Step 1: Implement** `src/features/flows/execute-flow.ts`

```ts
import { prisma } from '@/lib/prisma'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { interpretFlow, type RunAgentFn, type StepOutcome } from './interpret'

export type FlowExecutionJob = { flowId: string; organizationId: string; userId: string; input?: string; flowRunId?: string }

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export async function runFlowExecution(job: FlowExecutionJob): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const graph = flowGraphSchema.parse(flow.graph)
  const input = job.input ?? ''

  const run = job.flowRunId
    ? await prisma.flowRun.update({ where: { id: job.flowRunId }, data: { status: 'running' } })
    : await prisma.flowRun.create({
        data: { flowId: flow.id, status: 'running', input: { prompt: input }, organizationId: job.organizationId, userId: job.userId },
      })

  let order = 0
  // Adapter: each agent node runs the real agent and records a FlowRunStep.
  const runAgent: RunAgentFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: node.id, order: order++, status: 'running', input: { prompt: node.input }, startedAt: new Date() },
    })
    try {
      const result = (await runAgentExecution({
        agentId: node.agentId,
        organizationId: job.organizationId,
        userId: job.userId,
        input: node.input,
      })) as { summary?: string; status?: string; question?: string }
      if (typeof result?.status === 'string' && result.status.startsWith('waiting')) {
        await prisma.flowRunStep.update({ where: { id: step.id }, data: { status: 'waiting', finishedAt: new Date() } })
        return { waiting: { status: result.status, question: result.question } }
      }
      const output = result?.summary ?? ''
      await prisma.flowRunStep.update({ where: { id: step.id }, data: { status: 'succeeded', output: jsonValue(output), finishedAt: new Date() } })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.flowRunStep.update({ where: { id: step.id }, data: { status: 'failed', error: message.slice(0, 300), finishedAt: new Date() } })
      return { error: message }
    }
  }

  const result = await interpretFlow(graph, input, { runAgent })
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'waiting' ? 'waiting' : 'failed'
  await prisma.flowRun.update({
    where: { id: run.id },
    data: { status, output: jsonValue(result.output), finishedAt: status === 'waiting' ? null : new Date() },
  })
  return { flowRunId: run.id, status, output: result.output }
}
```

- [ ] **Step 2: Typecheck** — Run: `npm run typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/flows/execute-flow.ts
git commit -m "feat(flows): prisma-backed runFlowExecution over runAgentExecution"
```

---

## Task 6: Flow serializer + CRUD API (`src/lib/flows/serialize.ts`, `src/app/api/flows/route.ts`)

**Files:**
- Create: `src/lib/flows/serialize.ts`, `src/app/api/flows/route.ts`

**Interfaces:**
- Consumes: `flowGraphSchema` from `@/lib/flows/graph`.
- Produces: `serializeFlow(row)` → `{ id, name, description, status, trigger, graph, visibility, stepCount, createdAt, updatedAt }`; REST `GET/POST/PUT/DELETE /api/flows`.

- [ ] **Step 1: Implement `src/lib/flows/serialize.ts`**

```ts
import type { FlowGraph } from '@/lib/flows/graph'

export function serializeFlow(flow: {
  id: string; name: string; description: string; status: string
  trigger: unknown; graph: unknown; visibility: string; createdAt: Date; updatedAt: Date
}) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  const stepCount = (graph.nodes || []).filter((n) => n.type === 'agent').length
  return {
    id: flow.id, name: flow.name, description: flow.description, status: flow.status.toLowerCase(),
    trigger: flow.trigger ?? { type: 'manual' }, graph, visibility: flow.visibility,
    stepCount, createdAt: flow.createdAt, updatedAt: flow.updatedAt,
  }
}
```

- [ ] **Step 2: Implement `src/app/api/flows/route.ts`** (mirror `src/app/api/agents/route.ts` patterns exactly)

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { serializeFlow } from '@/lib/flows/serialize'

const triggerSchema = z.object({ type: z.enum(['manual', 'schedule', 'signal']).default('manual') }).passthrough()
const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).default('DRAFT'),
  visibility: z.enum(['shared', 'private']).default('shared'),
  trigger: triggerSchema.default({ type: 'manual' }),
  graph: flowGraphSchema.default(emptyGraph()),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    orderBy: { updatedAt: 'desc' }, take: 200,
  })
  return { success: true, flows: flows.map(serializeFlow) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = flowSchema.parse(await request.json())
  const flow = await prisma.flow.create({
    data: {
      name: data.name, description: data.description, status: data.status, visibility: data.visibility,
      trigger: data.trigger, graph: data.graph, organizationId: auth.organizationId, userId: auth.dbUser.id,
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(flowSchema.partial()).parse(await request.json())
  const existing = await prisma.flow.findFirst({ where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) } })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const flow = await prisma.flow.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.trigger !== undefined && { trigger: body.trigger }),
      ...(body.graph !== undefined && { graph: body.graph }),
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.flow.deleteMany({ where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) } })
  if (!result.count) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return { success: true }
})
```

- [ ] **Step 3: Typecheck + lint** — Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/flows/serialize.ts src/app/api/flows/route.ts
git commit -m "feat(flows): flow serializer + CRUD API"
```

---

## Task 7: Execute + runs API

**Files:**
- Create: `src/app/api/flows/[id]/execute/route.ts`, `src/app/api/flows/[id]/runs/route.ts`

**Interfaces:**
- Consumes: `runFlowExecution` from `@/features/flows/execute-flow`.
- Produces: `POST /api/flows/[id]/execute` → `{ success, run: { flowRunId, status, output } }`; `GET /api/flows/[id]/runs` → `{ success, runs: [...], latest: { id, status, steps: [{ nodeId, status, order }] } | null }`.

- [ ] **Step 1: Implement `src/app/api/flows/[id]/execute/route.ts`**

```ts
import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { runFlowExecution } from '@/features/flows/execute-flow'

export const POST = withAuthenticatedApi(async (request, auth, ctx) => {
  const { id } = (ctx?.params ?? {}) as { id: string }
  const body = await request.json().catch(() => ({}))
  const input = z.object({ input: z.string().optional() }).parse(body).input ?? ''
  const run = await runFlowExecution({ flowId: id, organizationId: auth.organizationId, userId: auth.dbUser.id, input })
  return { success: true, run }
})
```

(If `withAuthenticatedApi` does not pass route params, read `id` from `request.nextUrl.pathname` — confirm the handler signature in `src/lib/server/api-handler.ts` before writing this step and match it; mirror any existing `[id]` route such as under `src/app/api/agents/[id]/`.)

- [ ] **Step 2: Implement `src/app/api/flows/[id]/runs/route.ts`**

```ts
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (_request, auth, ctx) => {
  const { id } = (ctx?.params ?? {}) as { id: string }
  const runs = await prisma.flowRun.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { startedAt: 'desc' }, take: 20,
    include: { steps: { orderBy: { order: 'asc' }, select: { nodeId: true, status: true, order: true, error: true } } },
  })
  const latest = runs[0]
    ? { id: runs[0].id, status: runs[0].status, steps: runs[0].steps }
    : null
  return {
    success: true,
    runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt })),
    latest,
  }
})
```

- [ ] **Step 3: Typecheck + lint** — Run: `npm run typecheck && npm run lint` → PASS. (Resolve the params-access pattern against the real handler signature.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/flows/[id]
git commit -m "feat(flows): execute + runs API"
```

---

## Task 8: Copilot endpoint (`src/app/api/flows/copilot/route.ts`)

**Files:**
- Create: `src/app/api/flows/copilot/route.ts`

**Interfaces:**
- Consumes: `generateStructured` from `@/lib/llm/model-runner`; `flowGraphSchema` from `@/lib/flows/graph`; the caller's agent roster (fetched here).
- Produces: `POST /api/flows/copilot` `{ description }` → `{ success, graph }` (validated against `flowGraphSchema`, agent ids constrained to the workspace).

- [ ] **Step 1: Implement `src/app/api/flows/copilot/route.ts`**

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { readAgentMetadata } from '@/lib/agents/metadata'

const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
  },
  required: ['nodes', 'edges'],
  additionalProperties: false,
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description } = z.object({ description: z.string().min(1) }).parse(await request.json())
  const agents = await prisma.agentTask.findMany({
    where: { organizationId: auth.organizationId, status: 'ACTIVE', ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, description: true, metadata: true }, take: 100,
  })
  const roster = agents.map((a) => ({ id: a.id, name: readAgentMetadata(a.metadata).title || a.description })).filter((r) => r.name)
  const system =
    'You design agent pipelines as a JSON graph. Nodes: trigger (exactly one, id "trigger"), agent ' +
    '(data.agentId MUST be an id from the roster; data.input may reference {{trigger.input}}, {{step.<nodeId>.output}}, {{item}}), ' +
    'condition (data: left, op in [eq,neq,gt,gte,lt,lte,contains,matches], right), loop (data: over, concurrency, body[nodeIds]), ' +
    'parallel (data: branches[[nodeIds]]). Edges connect node ids; a condition edge has branch "true"/"false". ' +
    'Only use agents from the roster. Return ONLY the graph.'
  const user = `Roster:\n${roster.map((r) => `- ${r.name} (id: ${r.id})`).join('\n')}\n\nBuild a flow that: ${description}`

  try {
    const raw = await generateStructured({ system, user, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph', maxTokens: 2000 })
    const candidate = flowGraphSchema.parse(JSON.parse(raw))
    // Drop agent nodes referencing unknown ids; keep the graph valid.
    const ids = new Set(roster.map((r) => r.id))
    const nodes = candidate.nodes.filter((n) => n.type !== 'agent' || ids.has(n.data.agentId))
    const keep = new Set(nodes.map((n) => n.id))
    const edges = candidate.edges.filter((e) => keep.has(e.source) && keep.has(e.target))
    return { success: true, graph: { nodes, edges } }
  } catch {
    return { success: true, graph: emptyGraph() }
  }
})
```

- [ ] **Step 2: Typecheck + lint** — Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/flows/copilot/route.ts
git commit -m "feat(flows): copilot endpoint scaffolds a graph from a description"
```

---

## Task 9: Scheduler integration (`src/app/api/cron/dispatch/route.ts`)

**Files:**
- Modify: `src/app/api/cron/dispatch/route.ts`

**Interfaces:**
- Consumes: `runFlowExecution` from `@/features/flows/execute-flow`; the existing `isDue`/`AgentSchedule` from `@/lib/scheduling/due`.
- Produces: scheduled `ACTIVE` flows whose `trigger.type === 'schedule'` are executed each due tick, tracked by a `flow_runs` row (used as the "last run" marker).

- [ ] **Step 1: Add a flows pass after the agents loop.** In the tick handler, after the existing `for (const agent of dueAgents)` block, add:

```ts
// Scheduled flows: reuse the same due-check. A flow's schedule lives on
// flow.trigger; its most-recent flow_run.startedAt is the "last run" marker.
const flows = await prisma.flow.findMany({
  where: { organizationId: { in: orgIds }, status: 'ACTIVE' },
  include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true } } },
  take: 100,
})
for (const flow of flows) {
  const trigger = flow.trigger as { type?: string } | null
  const schedule = flow.trigger as unknown as AgentSchedule | null
  if (!trigger || trigger.type !== 'schedule' || !schedule) continue
  const last = flow.runs[0]?.startedAt ?? null
  if (!isDue(schedule, last, now)) continue
  if (workerOwnsRecurring && schedule.type !== 'once') continue
  const owner = flow.userId
    ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
    : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
  if (!owner) continue
  try {
    await runFlowExecution({ flowId: flow.id, organizationId: flow.organizationId, userId: owner.id, input: '' })
  } catch (error) {
    apiLogger.error('cron/dispatch: flow failed', { flowId: flow.id, error: error instanceof Error ? error.message : String(error) })
  }
}
```

(Match `orgIds`/`now`/`workerOwnsRecurring`/`apiLogger` to the names already in scope in that file; read the surrounding code first and adapt. The `trigger` JSON stores schedule fields flat — `{ type:'schedule'|'daily'|..., time, cron, timezone }` — matching `AgentSchedule`.)

- [ ] **Step 2: Add the import** at the top of the file:

```ts
import { runFlowExecution } from '@/features/flows/execute-flow'
```

- [ ] **Step 3: Typecheck + lint** — Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/dispatch/route.ts
git commit -m "feat(flows): dispatch scheduled flows from the cron tick"
```

---

## Task 10: Sidebar nav + `/flows` list page

**Files:**
- Modify: `src/components/layout/sidebar.tsx` (add nav entry)
- Create: `src/app/flows/page.tsx`

**Interfaces:**
- Consumes: `GET /api/flows`; `Pagination`/`paginate` from `@/components/ui/pagination`; `DashboardLayout` (match how `src/app/templates/page.tsx` wraps its page).
- Produces: a `/flows` route reachable from the sidebar.

- [ ] **Step 1: Add the nav entry.** In `src/components/layout/sidebar.tsx`, import `Workflow` from `lucide-react` and add to `navigation` after Explore:

```ts
{ name: 'Flows', href: '/flows', icon: Workflow },
```

- [ ] **Step 2: Implement `src/app/flows/page.tsx`** — model it on `src/app/templates/page.tsx` (read that file first for the layout wrapper, empty state, and pagination usage). Requirements: fetch `/api/flows`; show flow cards (name, description, `stepCount` steps, status badge); `PAGE_SIZE = 9` with `paginate` + `<Pagination>`; a **New flow** button that `POST`s `{ name: 'Untitled flow' }` to `/api/flows` then routes to `/flows/${flow.id}`; an empty state ("No flows yet — build your first agent pipeline").

- [ ] **Step 3: Verify** — Run: `npm run typecheck && npm run lint` → PASS. (UI is validated on Vercel; no local dev server.)

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/sidebar.tsx src/app/flows/page.tsx
git commit -m "feat(flows): sidebar entry + flows list page"
```

---

## Task 11: Builder — canvas + config drawer + copilot + live status (`src/app/flows/[id]/page.tsx` + `src/components/flows/*`)

**Files:**
- Create: `src/app/flows/[id]/page.tsx` (top bar, state, save, run, live-status polling)
- Create: `src/components/flows/flow-canvas.tsx` (vertical pipeline render + insert buttons)
- Create: `src/components/flows/step-card.tsx` (one node card + status dot)
- Create: `src/components/flows/step-drawer.tsx` (config drawer: node type, agent picker, input template, onError / condition / loop fields)
- Create: `src/components/flows/copilot-panel.tsx` (chat → `/api/flows/copilot`)

**Interfaces:**
- Consumes: `GET/PUT /api/flows` (load/save the graph), `POST /api/flows/[id]/execute`, `GET /api/flows/[id]/runs` (poll live status), `POST /api/flows/copilot`, `GET /api/agents` (agent picker roster); `FlowGraph`, `FlowNode` from `@/lib/flows/graph`; existing `Button`, `Skeleton`, `IntegrationChip`.
- Produces: the `/flows/[id]` builder.

Follow the design guide (memory: design-guide-url) and match existing page styling (`src/app/templates/[id]/page.tsx`, `src/app/dashboard/agent-config-form.tsx`).

- [ ] **Step 1: `step-card.tsx`** — a card for one node: numbered index, node icon by type (agent → Bot, condition → GitBranch, loop → Repeat, parallel → Rows), title (agent label / "If {left} {op} {right}" / "For each {over}"), and a status dot colored by the current run step status (`queued` gray, `running` amber pulse, `succeeded` green, `failed` red, `waiting` blue). Props: `{ node, index, status?, onClick }`.

- [ ] **Step 2: `flow-canvas.tsx`** — render the graph as a vertical list: a Trigger card at top, then nodes in main-chain order joined by a vertical connector with a `+` insert button between and after each step (calls `onInsertAfter(nodeId)`). Condition nodes render their `true`/`false` child edges as two indented branches. Loop nodes render their `body` cards indented inside a bordered container. Props: `{ graph, statusByNode, onSelect(nodeId), onInsertAfter(nodeId) }`.

- [ ] **Step 3: `step-drawer.tsx`** — right-hand drawer for the selected node. A node-type selector (Agent / If-else / For-each / Parallel). For `agent`: a searchable agent `<select>`/combobox over `GET /api/agents` (show all, not 5 — this mirrors the agent-config fix), an input-template `<textarea>` with an "Insert token" helper listing `{{trigger.input}}`, `{{step.<id>.output}}` for upstream nodes, and `{{item}}` when inside a loop, and an `onError` toggle (stop/continue). For `condition`: left template, op `<select>` (the 8 ops), right value. For `loop`: `over` template + `concurrency` number + body agent picker. Emits `onChange(updatedNode)` and `onDelete(nodeId)`. Props: `{ node, agents, upstreamNodeIds, insideLoop, onChange, onDelete, onClose }`.

- [ ] **Step 4: `copilot-panel.tsx`** — a right-most chat: a textarea + "Generate", posts `{ description }` to `/api/flows/copilot`, and calls `onGraph(graph)` with the result so the page replaces/merges the canvas. Show the returned step count and a note "AI-generated — review before running." Props: `{ onGraph }`.

- [ ] **Step 5: `src/app/flows/[id]/page.tsx`** — compose it:
  - Load the flow via `GET /api/flows` (find by id) into `graph` state; editable name in the top bar.
  - **BUILD / TEST** toggle; **Save** (`PUT /api/flows` with `{ id, name, graph }`); **Run** (`POST /api/flows/[id]/execute`, then start polling); **Exit** → `/flows`.
  - Graph mutations: `insertAfter(nodeId)` appends a new `agent` node + rewires the outgoing edge; selecting a node opens `step-drawer`; `onChange` updates the node in `graph`; `onDelete` removes the node + its edges and heals the chain.
  - **Live status:** while a run is active (or always in TEST mode) poll `GET /api/flows/[id]/runs` every 2s, build `statusByNode` from `latest.steps`, pass to the canvas; stop polling when `latest.status` is terminal (`succeeded`/`failed`) — keep polling on `waiting`.
  - Layout: center canvas, right config drawer (when a node is selected), right-most copilot panel (toggle). Use existing primitives; keep the three columns responsive (drawer/copilot collapse under `lg`).

- [ ] **Step 6: Verify** — Run: `npm run typecheck && npm run lint && npm test` → PASS (0 TS errors, lint clean, all tests pass).

- [ ] **Step 7: Commit**

```bash
git add src/app/flows/[id] src/components/flows
git commit -m "feat(flows): Workato-style builder — canvas, config drawer, copilot, live status"
```

---

## Self-review notes (addressed)

- **Spec coverage:** models+migration (T1); graph types (T2); templates/conditions (T3); agent/condition/loop/parallel runner + guards + ask-user pause (T4); prisma orchestrator reusing `runAgentExecution` (T5); CRUD (T6); execute/runs (T7); copilot (T8); schedule trigger (T9); nav+list (T10); Workato-style canvas+drawer+copilot+live status (T11). Phase-2 items (transform nodes, advanced on-error routing, richer TEST mode, zoom/pan) are intentionally omitted.
- **Type consistency:** `runAgentExecution` result treated as `{ summary }` / `{ status:'waiting_*' }` in T5, matching the fixed run_agent code and `execute-agent.ts`. `RunAgentFn`/`StepOutcome`/`InterpretResult` names are consistent T4→T5. `flowGraphSchema`/`ConditionOp`/`emptyGraph` consistent T2→T3→T6→T8.
- **Open verification during build:** the exact `withAuthenticatedApi` route-params signature (T7) and the in-scope variable names in `dispatch/route.ts` (T9) must be read from source and matched — flagged inline in those tasks.
