# WS5+6: Copilot Completion + Conversational Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec sections 5-6 of `docs/superpowers/specs/2026-07-08-flow-parity-design.md`. WS5 remainder (grounding/repair/prompt-rules largely shipped already): a second repair round, the structured-response rule, and a surfaced "needs attention" list. WS6 (new): the copilot panel becomes a conversational builder that edits the live graph through structured operations applied via the tested `mutate.ts` helpers, undo-integrated, with touched-node highlighting and clarifying questions instead of broken graphs.

**Architecture:** The heart is a pure, fully-tested ops layer: `src/lib/flows/copilot-ops.ts` defines a zod op vocabulary (`add`/`update`/`delete`/`move`/`setTrigger`/`replace`) and `applyCopilotOps(graph, ops)` which routes every mutation through existing `mutate.ts` functions and reports applied/skipped/touched. A new `/api/flows/copilot/chat` endpoint shares the existing grounding context (extracted to a helper), returns `{ message, ops, needsAttention }` with server-side op sanitization (`replace` graphs run the full normalize/repair/validate pipeline server-side). The panel becomes a chat; the page applies ops via `commitGraph` (undo free) and pulses touched nodes.

**Tech Stack:** Existing copilot lib (`normalize/repair/validationIssuesForModel`), `generateStructured` (+ `strictifySchema` already applied at the wire), zod, `mutate.ts`, `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent. Baseline 370 pass / 6 skip; 4 pre-existing lint warnings. Never run dev/build/prisma-migrate.
- Op vocabulary EXACTLY: `{ op: 'add', type: StepType, afterId: string, data?: Record<string, unknown> }`, `{ op: 'update', id: string, data: Record<string, unknown> }`, `{ op: 'delete', id: string }`, `{ op: 'move', id: string, afterId: string }`, `{ op: 'setTrigger', trigger: Record<string, unknown> }`, `{ op: 'replace', graphJson: string }`. Adds default onto `insertNodeAfter`'s node then deep-merge `data`; every resulting node must pass `flowNodeSchema` or the op is SKIPPED with a reason (never a corrupt graph).
- Chat history cap: 20 messages, each ≤ 4000 chars (server-truncated). `needsAttention` = `{ nodeId?: string, message: string }[]` from the FINAL validation pass.
- The chat endpoint NEVER returns raw unvalidated ops: every op is zod-parsed; `replace.graphJson` is parsed → `normalizeGeneratedFlowGraphInput` → `flowGraphSchema` → `repairGeneratedFlowGraph` server-side and re-serialized; invalid ops are dropped and named in an appended sentence on `message`.
- Highlight pulse: indigo ring on touched nodes clearing after 2500ms.
- The one-shot generate endpoint keeps its exact request/response contract (Fix-with-Copilot and any old callers unaffected); it ADDS `needsAttention` to the response.

---

### Task 1: Generate-mode completion (WS5 remainder)

**Files:**
- Modify: `src/app/api/flows/copilot/route.ts`
- Modify: `src/components/flows/copilot-panel.tsx` (needs-attention hook)
- Modify: `src/app/flows/[id]/page.tsx` (open checker on needs-attention)

**Interfaces:**
- Produces: generate response gains `needsAttention: { nodeId?: string; message: string }[]`; `CopilotPanel` gains optional prop `onNeedsAttention?: (issues: { nodeId?: string; message: string }[]) => void`; exported helper `buildCopilotGrounding(auth: AuthContext): Promise<{ system negotiated pieces... }>` — concretely: extract the roster/tools/contextBlock/system-rules assembly into `export async function buildCopilotGrounding(organizationId: string, userId: string): Promise<{ roster: { id: string; name: string }[]; toolCatalog: ToolCatalog; contextBlock: string; graphRules: string }>` in a NEW file `src/lib/flows/copilot-grounding.ts` (server-only; move `toolInputHint`/`toolOutputHint` there), consumed by BOTH routes.

- [ ] **Step 1: Extract grounding**

Create `src/lib/flows/copilot-grounding.ts` by MOVING (not duplicating) the roster query, tool catalog load, `toolInputHint`/`toolOutputHint`, the `contextBlock` template, and the long system-rules string (`graphRules`) out of the generate route; the route imports and uses it. Behavior byte-identical.

- [ ] **Step 2: Second repair round + structured-response rule + needsAttention**

In the generate route:
- Wrap the existing single repair block in a loop: up to TWO repair attempts (`for (let round = 0; round < 2 && !validation.ok; round += 1) { …existing repair prompt + regenerate + revalidate… }`).
- Append to `graphRules` (in the grounding file): `'When a later step references {{step.<agentNodeId>.output.<field>}}, that agent node MUST set responseFormat: "structured" and declare outputFields: [{name,type}] matching the referenced fields.'`
- Final response adds `needsAttention: [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))`.

- [ ] **Step 3: Panel + page hook**

`copilot-panel.tsx`: after a successful generate, call `onNeedsAttention?.(data.needsAttention ?? [])` (keep the existing toasts). Page: pass `onNeedsAttention={(issues) => { if (issues.length) setShowChecker(true) }}`.

- [ ] **Step 4: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/copilot-grounding.ts src/app/api/flows/copilot/route.ts src/components/flows/copilot-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): copilot generate — shared grounding, two repair rounds, needs-attention"
```

---

### Task 2: Ops vocabulary + applyCopilotOps (the core)

**Files:**
- Create: `src/lib/flows/copilot-ops.ts`
- Test: `src/lib/flows/__tests__/copilot-ops.test.ts`

**Interfaces:**
- Consumes: `insertNodeAfter`, `appendToBranch` (NOT used v1 — adds go after a node), `updateNode`, `deleteNode`, `moveNodeAfter`, `sanitizeCopiedNode` patterns, `flowNodeSchema`/`flowGraphSchema`, `normalizeGeneratedFlowGraphInput` (for replace on the SERVER only — client replace receives a pre-sanitized graph object; see Task 3).
- Produces:

```ts
export const copilotOpSchema: z.ZodType<CopilotOp>  // discriminated union on 'op', vocabulary per Global Constraints
export type CopilotOp = …
export type ApplyResult = {
  graph: FlowGraph
  applied: number
  skipped: { op: CopilotOp; reason: string }[]
  touchedIds: string[]
}
export function applyCopilotOps(graph: FlowGraph, ops: CopilotOp[]): ApplyResult
```

Semantics: ops apply sequentially against the evolving graph; `add` = `insertNodeAfter(graph, afterId, type)` then deep-merge `data` into the new node's data and `flowNodeSchema`-validate the merged node (parse failure → revert that op, skip with reason); `update` = merge into existing node data + validate (trigger node updatable only via `setTrigger`); `delete`/`move` guard target existence (+ move's own no-op conditions reported as skipped when the graph comes back identical); `setTrigger` merges into the trigger node's `data.trigger`; `replace` (client-side) = swap to `op.graph` when present (`{ op: 'replace', graphJson }` also carries an OPTIONAL server-attached `graph?: FlowGraph` — client applies `graph`, never parses `graphJson` itself; when `graph` absent → skip with reason `unsanitized replace`). `touchedIds` collects new/updated/moved node ids (delete contributes nothing; replace touches nothing — the whole canvas changes).

- [ ] **Step 1: Failing tests** (`copilot-ops.test.ts` — node:test; build graphs with `emptyGraph`/`insertNodeAfter` like mutate tests):

```ts
test('add inserts after target with merged data and validates', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [{ op: 'add', type: 'http', afterId: 'trigger', data: { url: 'https://x.test', method: 'GET' } }] as CopilotOp[])
  assert.equal(result.applied, 1)
  const node = result.graph.nodes.find((n) => n.type === 'http')!
  assert.equal((node.data as { url: string }).url, 'https://x.test')
  assert.deepEqual(result.touchedIds, [node.id])
})

test('add with data that breaks the node schema is skipped, graph unchanged', () => {
  const g = emptyGraph()
  const result = applyCopilotOps(g, [{ op: 'add', type: 'http', afterId: 'trigger', data: { method: 'TELEPORT' } }] as CopilotOp[])
  assert.equal(result.applied, 0)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /schema|invalid/i)
  assert.equal(result.graph, g)
})

test('update merges node data; unknown id skipped; trigger update rejected', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'stop').graph
  const stop = g.nodes.find((n) => n.type === 'stop')!.id
  const ok = applyCopilotOps(g, [{ op: 'update', id: stop, data: { reason: 'done' } }] as CopilotOp[])
  assert.equal(ok.applied, 1)
  const missing = applyCopilotOps(g, [{ op: 'update', id: 'nope', data: {} }] as CopilotOp[])
  assert.equal(missing.skipped[0].reason.includes('not found'), true)
  const trig = applyCopilotOps(g, [{ op: 'update', id: 'trigger', data: {} }] as CopilotOp[])
  assert.equal(trig.applied, 0)
})

test('delete and move route through mutate helpers; sequential ops see prior results', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const a = g.nodes.find((n) => n.type === 'http')!.id
  const result = applyCopilotOps(g, [
    { op: 'add', type: 'stop', afterId: a },
    { op: 'delete', id: a },
  ] as CopilotOp[])
  assert.equal(result.applied, 2)
  assert.equal(result.graph.nodes.some((n) => n.id === a), false)
  assert.equal(result.graph.nodes.some((n) => n.type === 'stop'), true)
})

test('setTrigger merges trigger data; replace applies only server-sanitized graphs', () => {
  const g = emptyGraph()
  const trig = applyCopilotOps(g, [{ op: 'setTrigger', trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00' } } }] as CopilotOp[])
  assert.equal(trig.applied, 1)
  const t = trig.graph.nodes.find((n) => n.type === 'trigger')!
  assert.equal(((t.data as { trigger: { type: string } }).trigger).type, 'schedule')
  const unsanitized = applyCopilotOps(g, [{ op: 'replace', graphJson: '{"nodes":[],"edges":[]}' }] as CopilotOp[])
  assert.equal(unsanitized.applied, 0)
  const sane = applyCopilotOps(g, [{ op: 'replace', graphJson: '', graph: insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph } as CopilotOp])
  assert.equal(sane.applied, 1)
  assert.equal(sane.graph.nodes.some((n) => n.type === 'stop'), true)
})
```

- [ ] **Step 2: RED → implement → GREEN** (zod schema with `.passthrough()` on data objects; deep-merge = shallow spread of `data` over defaults is sufficient for node data — document that arrays replace wholesale). Full suite.

- [ ] **Step 3: Commit**

```bash
git add src/lib/flows/copilot-ops.ts src/lib/flows/__tests__/copilot-ops.test.ts
git commit -m "feat(flows): copilot edit-op vocabulary and pure apply engine"
```

---

### Task 3: Chat endpoint

**Files:**
- Create: `src/app/api/flows/copilot/chat/route.ts`

**Interfaces:**
- Consumes: `buildCopilotGrounding` (Task 1), `copilotOpSchema`/`CopilotOp` (Task 2), `generateStructured`, `normalizeGeneratedFlowGraphInput`/`repairGeneratedFlowGraph`/`flowGraphSchema`, `validateFlowGraph`.
- Produces: `POST /api/flows/copilot/chat` body `{ messages: { role: 'user' | 'assistant', content: string }[] (1-20, contents truncated to 4000), graph: unknown }` → `{ success: true, message: string, ops: CopilotOp[], needsAttention: { nodeId?: string, message: string }[] }`.

- [ ] **Step 1: Implement**

- zod-parse body; truncate/limit history per constraints; `flowGraphSchema.safeParse(graph)` (invalid → treat as `emptyGraph()`).
- System prompt: grounding `graphRules` + contextBlock + an OPS contract section: describe the six ops verbatim (names/fields), instruct: prefer minimal targeted ops over replace; use `replace` ONLY when building a brand-new flow or a full redesign is explicitly requested (`graphJson` = full graph JSON string, same shape rules as generation); when the request is ambiguous or impossible with these ops, return `ops: []` and ask ONE clarifying question in `message`; always explain what you did/need in `message`, mentioning node labels.
- User content: the serialized current graph + the chat transcript.
- Response schema for `generateStructured`: `{ type: 'object', properties: { message: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['message', 'ops'] }`, schemaName `'flow_edit_ops'`, maxTokens 3500. Tolerant parse (mirror `parseGeneratedGraphReply`'s fence handling — extract a tiny local helper).
- Sanitize ops: each through `copilotOpSchema.safeParse` → invalid dropped (collect count); for `replace` ops: parse `graphJson` → normalize → `flowGraphSchema.parse` → `repairGeneratedFlowGraph` with grounding context → attach as `op.graph` (failures drop the op). Append to `message` when anything dropped: `` ` (I discarded ${n} change${…} that didn't validate.)` ``.
- `needsAttention`: apply the sanitized ops server-side via `applyCopilotOps` to a COPY of the parsed graph, run `validateFlowGraph` on the result with the grounding context, map errors+warnings. (This also future-proofs: the server knows the post-edit state.)
- Errors from `generateStructured` → `{ success: false, error }` shaped like the generate route's catch (503-style message on provider absence — mirror it).

- [ ] **Step 2: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/api/flows/copilot/chat/route.ts'
git commit -m "feat(flows): conversational copilot endpoint — sanitized edit ops with needs-attention"
```

---

### Task 4: Chat panel + page application + highlight pulse

**Files:**
- Modify: `src/components/flows/copilot-panel.tsx` (chat UI; keep one-shot Generate as a secondary affordance for an EMPTY canvas only)
- Modify: `src/app/flows/[id]/page.tsx`
- Modify: `src/components/flows/flow-canvas.tsx` + `src/components/flows/step-card.tsx` (highlight prop)

**Interfaces:**
- `CopilotPanel` new props: `graph: FlowGraph`, `onOps: (ops: CopilotOp[]) => { applied: number; skipped: { reason: string }[] }`, `onJump: (nodeId: string) => void`, existing `onGraph`/`onNeedsAttention` kept.
- `FlowCanvas` + `StepCard`: `highlightIds?: string[]` / `highlighted?: boolean` → indigo pulse ring (`ring-2 ring-indigo-300 animate-pulse` while highlighted; selection styling wins).

- [ ] **Step 1: Panel chat UI**

Rework `copilot-panel.tsx`: messages state `{ role, content, needsAttention? }[]`; scrollable thread (user right-aligned muted bubble, assistant left with Sparkles avatar — match card/panel styling conventions); input row (textarea grows, Enter sends, Shift+Enter newline) + send button (loading state); on send: POST `/api/flows/copilot/chat` with the running history (client also caps at 20) + `graph` prop; on response: `const result = onOps(data.ops)`; append assistant message showing `data.message` + a compact result line (`Applied N change${s}` / skipped count) + `needsAttention` items as small amber rows — items with `nodeId` are buttons calling `onJump(nodeId)`; also forward `onNeedsAttention?.(data.needsAttention)`. Empty-canvas state: keep a `Generate a flow` quick action that calls the EXISTING one-shot endpoint via the current `generate()` path (visible only when `graph.nodes.length <= 1`), plus the chat input. Failure: assistant-style error bubble.

- [ ] **Step 2: Page wiring**

- `import { applyCopilotOps, type CopilotOp } from '@/lib/flows/copilot-ops'`.
- `const [highlightIds, setHighlightIds] = useState<string[]>([])` + a ref'd timeout; `onOps`:

```ts
    (ops: CopilotOp[]) => {
      if (viewingVersion) {
        toast.error('Close the version view before applying copilot changes.')
        return { applied: 0, skipped: ops.map(() => ({ reason: 'read-only version view' })) }
      }
      const result = applyCopilotOps(graph, ops)
      if (result.applied > 0) {
        commitGraph(result.graph)
        setSelectedId(null)
        setHighlightIds(result.touchedIds)
        window.clearTimeout(highlightTimer.current)
        highlightTimer.current = window.setTimeout(() => setHighlightIds([]), 2500)
      }
      return { applied: result.applied, skipped: result.skipped.map((s) => ({ reason: s.reason })) }
    }
```

- Pass `graph`, `onOps`, `onJump={jumpToNode}` to the panel; `highlightIds={highlightIds}` to the canvas.

- [ ] **Step 3: Canvas/card highlight**

`flow-canvas.tsx`: `highlightIds?: string[]` prop → `highlighted={highlightIds?.includes(node.id)}` in `card()`. `step-card.tsx`: `highlighted?: boolean` prop → in the root `cn(...)`, when highlighted AND not selected: `border-indigo-400 ring-2 ring-indigo-200 animate-pulse` (selection wins; error ring loses to highlight for the pulse duration — order the ternary: selected > highlighted > errors > warnings > default).

- [ ] **Step 4: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/copilot-panel.tsx src/components/flows/flow-canvas.tsx src/components/flows/step-card.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): conversational copilot — chat panel, applied edits, node pulse"
```

---

### Task 5: Final verification

- [ ] `npm run typecheck && npm run lint && npm test` — all green.
- [ ] Reasoning smoke checklist: chat "add a step that posts to Slack after scoring" → targeted add op applied + pulsed + undo-able (⌘Z reverts); invalid model ops dropped server-side and named; ambiguous ask → clarifying question, zero ops; brand-new flow via replace (server-sanitized); needs-attention rows jump to nodes and open the checker path; version viewing blocks onOps; generate mode unchanged for Fix-with-Copilot (`currentGraph`/`issues` contract intact) and now returns needsAttention; the empty-canvas Generate quick action still works.
