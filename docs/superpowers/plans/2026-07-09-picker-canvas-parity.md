# WS2: Picker/Catalog UX + Canvas Behavior Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 2 (incl. its scope addition) of `docs/superpowers/specs/2026-07-08-flow-parity-design.md`: an MS-style Add-trigger/Add-action picker (search, favorites, drill-in groups, connector browsing) plus the canvas behaviors — nav rail (zoom/fit/search), drag-to-reorder, floating dynamic-content popover, inline validation badges/outlines, keyboard shortcuts (Del/⌘C/⌘V), and copy/paste steps.

**Architecture:** Pure/lib first: a static built-ins manifest (`builtin-catalog.ts`) and three new graph mutations (`moveNodeAfter`, `moveContainerStep`, `pasteNode`) with full TDD. Then UI: a data-driven `FlowPicker` component replaces the InsertMenu popover content (same `onPick(type, seed)` contract); a `CanvasRail` component + page zoom state; drag handled by HTML5 DnD from card grips onto the existing connector zones; validation badges flow from the page's existing `validateFlowGraph` memo as an `issuesByNode` map; shortcuts live beside the existing undo/redo keydown handler; the token DataTree moves from below-body into a portal popover anchored to the focused field.

**Tech Stack:** React 18, Tailwind, `createPortal`, HTML5 drag-and-drop, localStorage, existing `mutate.ts`/`validate.ts`/`data-tree.tsx`, `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- Tests: `node:test` + `node:assert/strict` for lib modules (`src/lib/flows/__tests__/`); components verified by `npm run typecheck && npm run lint && npm test` (baseline 336 pass / 6 skip; 4 pre-existing lint warnings). Never run dev/build/prisma-migrate.
- Do not change the `onPick(type: StepType, seed?: FlowInsertSeed)` contract or any existing `mutate.ts` export.
- Exact values: favorites localStorage key `flows.pickerFavorites.v1` (string[] of item ids); clipboard localStorage key `flows.clipboard.v1` (serialized FlowNode); zoom localStorage key `flows.canvasZoom` (number, clamp 0.5–1.5, step 0.1); connector filter chips exactly `All` / `Built-in` / `Connected`; picker breadcrumb pattern `Add an action › <group>`.
- Keyboard shortcuts must not fire while typing: guard `INPUT`/`TEXTAREA`/`SELECT`/`isContentEditable` exactly like the existing undo handler in `src/app/flows/[id]/page.tsx`.
- Trigger node can never be dragged, deleted, copied-over, or reordered.

---

### Task 1: Built-ins manifest

**Files:**
- Create: `src/lib/flows/builtin-catalog.ts`
- Test: `src/lib/flows/__tests__/builtin-catalog.test.ts`

**Interfaces:**
- Consumes: `StepType` from `@/lib/flows/mutate`.
- Produces (Task 3 renders this verbatim):

```ts
export type PickerLeaf = {
  id: string                 // unique, used for favorites
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  // action leaves create a node:
  stepType?: StepType
  seed?: { agentId?: string; connectionId?: string; toolName?: string; label?: string }
  // trigger leaves set the trigger node's type:
  triggerType?: 'manual' | 'schedule' | 'webhook' | 'signal'
}
export type PickerGroup = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  children: PickerLeaf[]
}
export const BUILTIN_GROUPS: PickerGroup[]
export const AI_CAPABILITY_LEAVES: PickerLeaf[]   // action mode only
export const TRIGGER_LEAVES: PickerLeaf[]         // top-level trigger picks
export function searchCorpus(leaf: PickerLeaf): string  // label+description lowercased
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/flows/__tests__/builtin-catalog.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_GROUPS, AI_CAPABILITY_LEAVES, TRIGGER_LEAVES, searchCorpus } from '../builtin-catalog'

test('built-in groups cover the drill-in taxonomy', () => {
  const ids = BUILTIN_GROUPS.map((g) => g.id)
  assert.deepEqual(ids, ['http', 'control', 'data-operation', 'variable'])
  const control = BUILTIN_GROUPS.find((g) => g.id === 'control')!
  assert.deepEqual(control.children.map((c) => c.stepType), ['condition', 'switch', 'loop', 'parallel', 'stop'])
  const dataOp = BUILTIN_GROUPS.find((g) => g.id === 'data-operation')!
  assert.deepEqual(dataOp.children.map((c) => c.stepType), ['transform', 'filter'])
  const http = BUILTIN_GROUPS.find((g) => g.id === 'http')!
  assert.ok(http.children.every((c) => c.stepType === 'http'))
})

test('every leaf id is unique across groups, AI capabilities, and triggers', () => {
  const all = [...BUILTIN_GROUPS.flatMap((g) => g.children), ...AI_CAPABILITY_LEAVES, ...TRIGGER_LEAVES]
  assert.equal(new Set(all.map((l) => l.id)).size, all.length)
})

test('AI capabilities are action-mode agent steps', () => {
  assert.ok(AI_CAPABILITY_LEAVES.length >= 2)
  assert.ok(AI_CAPABILITY_LEAVES.every((l) => l.mode === 'action' && l.stepType === 'agent'))
})

test('trigger leaves cover all four trigger types', () => {
  assert.deepEqual(TRIGGER_LEAVES.map((l) => l.triggerType), ['manual', 'schedule', 'webhook', 'signal'])
})

test('searchCorpus is lowercase label+description', () => {
  const leaf = TRIGGER_LEAVES[0]
  assert.equal(searchCorpus(leaf), `${leaf.label} ${leaf.description}`.toLowerCase())
})
```

- [ ] **Step 2: Run to verify fail** — `npx tsx --test src/lib/flows/__tests__/builtin-catalog.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/lib/flows/builtin-catalog.ts`:

```ts
import type { StepType } from '@/lib/flows/mutate'

/** One pickable item in the Add-trigger/Add-action catalog. */
export type PickerLeaf = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  stepType?: StepType
  seed?: { agentId?: string; connectionId?: string; toolName?: string; label?: string }
  triggerType?: 'manual' | 'schedule' | 'webhook' | 'signal'
}

export type PickerGroup = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  children: PickerLeaf[]
}

/** Built-in tool groups with MS-style drill-in. */
export const BUILTIN_GROUPS: PickerGroup[] = [
  {
    id: 'http',
    label: 'HTTP',
    description: 'Call APIs and webhooks with full request control.',
    mode: 'action',
    children: [
      { id: 'http-request', label: 'HTTP', description: 'Send a request to any API endpoint and use the response.', mode: 'action', stepType: 'http' },
      { id: 'http-webhook-out', label: 'HTTP Webhook', description: 'Post a payload to an external webhook URL.', mode: 'action', stepType: 'http', seed: { label: 'Webhook' } },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    description: 'Branch, loop, and stop the flow.',
    mode: 'action',
    children: [
      { id: 'control-condition', label: 'Condition', description: 'Route down different paths based on a rule.', mode: 'action', stepType: 'condition' },
      { id: 'control-switch', label: 'Switch', description: 'Route to one of several cases, with a default path.', mode: 'action', stepType: 'switch' },
      { id: 'control-loop', label: 'For each', description: 'Run steps once for every item in a list.', mode: 'action', stepType: 'loop' },
      { id: 'control-parallel', label: 'Parallel branches', description: 'Run independent branches at the same time.', mode: 'action', stepType: 'parallel' },
      { id: 'control-stop', label: 'Stop flow', description: 'End the flow early with an optional message.', mode: 'action', stepType: 'stop' },
    ],
  },
  {
    id: 'data-operation',
    label: 'Data Operation',
    description: 'Shape and filter data between steps.',
    mode: 'action',
    children: [
      { id: 'data-compose', label: 'Set fields', description: 'Create named values later steps can reuse.', mode: 'action', stepType: 'transform' },
      { id: 'data-filter', label: 'Filter', description: 'Continue only when a value matches a rule.', mode: 'action', stepType: 'filter' },
    ],
  },
  {
    id: 'variable',
    label: 'Variable',
    description: 'Store a value for later steps.',
    mode: 'action',
    children: [
      { id: 'variable-set', label: 'Set variable', description: 'Save a named value for downstream steps.', mode: 'action', stepType: 'transform', seed: { label: 'Set variable' } },
    ],
  },
]

/** AI capabilities shown first in action mode. */
export const AI_CAPABILITY_LEAVES: PickerLeaf[] = [
  { id: 'ai-run-agent', label: 'Run an agent', description: 'Run one of your agents and pass its response to the next step.', mode: 'action', stepType: 'agent' },
  { id: 'ai-run-prompt', label: 'Run a prompt', description: 'One-off AI step: give instructions, get a response — no saved agent needed.', mode: 'action', stepType: 'agent', seed: { label: 'Run a prompt' } },
]

/** Trigger-mode top level: the four ways a flow can start. */
export const TRIGGER_LEAVES: PickerLeaf[] = [
  { id: 'trigger-manual', label: 'Manually trigger a flow', description: 'Start it from the builder or with typed inputs.', mode: 'trigger', triggerType: 'manual' },
  { id: 'trigger-schedule', label: 'Schedule', description: 'Run on a recurrence you define.', mode: 'trigger', triggerType: 'schedule' },
  { id: 'trigger-webhook', label: 'When an HTTP request is received', description: 'Start when an external system posts to a secret URL.', mode: 'trigger', triggerType: 'webhook' },
  { id: 'trigger-signal', label: 'When a signal fires', description: 'Start from an in-platform event, like another flow completing.', mode: 'trigger', triggerType: 'signal' },
]

export function searchCorpus(leaf: PickerLeaf): string {
  return `${leaf.label} ${leaf.description}`.toLowerCase()
}
```

- [ ] **Step 4: Run tests, full suite, commit**

`npx tsx --test src/lib/flows/__tests__/builtin-catalog.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/builtin-catalog.ts src/lib/flows/__tests__/builtin-catalog.test.ts
git commit -m "feat(flows): built-in picker catalog manifest"
```

---

### Task 2: Graph mutations — move, container reorder, paste

**Files:**
- Modify: `src/lib/flows/mutate.ts`
- Test: `src/lib/flows/__tests__/mutate.test.ts` (append)

**Interfaces:**
- Produces (Tasks 5 & 7 consume):
  - `moveNodeAfter(graph, nodeId: string, afterId: string): FlowGraph` — detach `nodeId` from its chain (heal like deleteNode but keep the node), then splice it after `afterId` (like insertNodeAfter but reusing the node). No-ops when: ids equal, either is missing, nodeId is `'trigger'`, `afterId` is inside the moved node's own container subtree, or nodeId is a contained body step (container bodies use the array variant instead).
  - `moveContainerStep(graph, containerId: string, from: number, to: number, branchIndex?: number): FlowGraph` — reorder a loop's `body` array (or parallel `branches[branchIndex]`); out-of-range no-ops.
  - `sanitizeCopiedNode(raw: unknown): FlowNode | null` — pure: parse an unknown value against `flowNodeSchema`, reject triggers, strip container bodies (`body: []` / `branches: []`), return null on anything invalid.
  - `pasteNodeAfter(graph, afterId: string, copied: FlowNode): { graph: FlowGraph; nodeId: string }` — fresh id, deep-copied data, spliced after `afterId`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/flows/__tests__/mutate.test.ts` (match its existing graph-builder style; standalone form shown):

```ts
test('moveNodeAfter relocates a middle node to the chain tail', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph        // n2? ids depend on builder — capture them
  const a = g.nodes.find((n) => n.type === 'http')!.id
  g = insertNodeAfter(g, a, 'transform').graph
  const b = g.nodes.find((n) => n.type === 'transform')!.id
  g = insertNodeAfter(g, b, 'stop').graph
  const c = g.nodes.find((n) => n.type === 'stop')!.id
  const moved = moveNodeAfter(g, a, c)
  // chain is trigger -> b -> c -> a
  const next = (id: string) => moved.edges.find((e) => e.source === id && !e.branch)?.target
  assert.equal(next('trigger'), b)
  assert.equal(next(b), c)
  assert.equal(next(c), a)
  assert.equal(next(a), undefined)
  assert.equal(moved.nodes.length, g.nodes.length)
})

test('moveNodeAfter no-ops for trigger, same id, missing ids, and own-subtree drops', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = g.nodes.find((n) => n.type === 'loop')!
  const bodyId = (loop.data as { body: string[] }).body[0]
  assert.equal(moveNodeAfter(g, 'trigger', bodyId), g)
  assert.equal(moveNodeAfter(g, loop.id, loop.id), g)
  assert.equal(moveNodeAfter(g, 'nope', loop.id), g)
  assert.equal(moveNodeAfter(g, loop.id, bodyId), g) // can't drop a container into itself
  assert.equal(moveNodeAfter(g, bodyId, 'trigger'), g) // body steps use the array variant
})

test('moveContainerStep reorders a loop body', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = () => g.nodes.find((n) => n.type === 'loop')! as Extract<FlowNode, { type: 'loop' }>
  g = addContainerStep(g, loop().id, 'transform').graph
  g = addContainerStep(g, loop().id, 'stop').graph
  const before = loop().data.body
  const after = moveContainerStep(g, loop().id, 0, 2)
  const reordered = (after.nodes.find((n) => n.type === 'loop') as Extract<FlowNode, { type: 'loop' }>).data.body
  assert.deepEqual(reordered, [before[1], before[2], before[0]])
  assert.equal(moveContainerStep(g, loop().id, 0, 99), g)
})

test('sanitizeCopiedNode accepts steps, rejects triggers and garbage, empties containers', () => {
  const http = { id: 'x1', type: 'http', data: { method: 'GET', url: 'https://a.test' } }
  const ok = sanitizeCopiedNode(http)
  assert.equal(ok?.type, 'http')
  assert.equal(sanitizeCopiedNode({ id: 't', type: 'trigger', data: {} }), null)
  assert.equal(sanitizeCopiedNode('garbage'), null)
  const loop = sanitizeCopiedNode({ id: 'l', type: 'loop', data: { over: '{{trigger.input}}', body: ['zombie'] } })
  assert.deepEqual((loop as Extract<FlowNode, { type: 'loop' }>).data.body, [])
})

test('pasteNodeAfter splices a fresh-id copy into the chain', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const a = g.nodes.find((n) => n.type === 'http')!.id
  const copied = sanitizeCopiedNode({ id: 'zzz', type: 'stop', data: { reason: 'done' } })!
  const { graph: pasted, nodeId } = pasteNodeAfter(g, a, copied)
  assert.notEqual(nodeId, 'zzz')
  const next = (id: string) => pasted.edges.find((e) => e.source === id && !e.branch)?.target
  assert.equal(next(a), nodeId)
  const node = pasted.nodes.find((n) => n.id === nodeId)!
  assert.equal(node.type, 'stop')
  assert.equal((node.data as { reason?: string }).reason, 'done')
})
```

Add the needed imports to the test file (`moveNodeAfter, moveContainerStep, sanitizeCopiedNode, pasteNodeAfter`, plus `addContainerStep`/`FlowNode` if absent).

- [ ] **Step 2: Run to verify fail** — `npx tsx --test src/lib/flows/__tests__/mutate.test.ts` → new tests FAIL (not exported).

- [ ] **Step 3: Implement in `src/lib/flows/mutate.ts`**

```ts
import { flowNodeSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
```

(replace the existing type-only graph import). Append:

```ts
/** Ids living inside a container node's own subtree (its body/branch steps). */
function containedIdsOf(node: FlowNode): string[] {
  if (node.type === 'loop') return node.data.body
  if (node.type === 'parallel') return node.data.branches.flat()
  return []
}

/**
 * Move an existing step so it sits immediately after `afterId`, healing both
 * the old and new positions. Container bodies are NOT movable this way — use
 * moveContainerStep. No-op on any invalid move.
 */
export function moveNodeAfter(graph: FlowGraph, nodeId: string, afterId: string): FlowGraph {
  if (nodeId === afterId || nodeId === 'trigger') return graph
  const node = graph.nodes.find((n) => n.id === nodeId)
  const target = graph.nodes.find((n) => n.id === afterId)
  if (!node || !target) return graph
  if (containedIdsOf(node).includes(afterId)) return graph
  // A step referenced by any container's body/branches moves via the array API.
  const contained = new Set(graph.nodes.flatMap(containedIdsOf))
  if (contained.has(nodeId)) return graph

  // 1) Detach: heal the chain around the node (deleteNode's edge logic, node kept).
  const incoming = graph.edges.find((edge) => edge.target === nodeId)
  const outgoing = graph.edges.find((edge) => edge.source === nodeId && !edge.branch)
  let edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  // Branch edges leaving a condition/switch node being moved stay with it —
  // conditions/switches carry their branch heads, so keep those edges intact.
  const branchEdges = graph.edges.filter((edge) => edge.source === nodeId && edge.branch)
  edges = [...edges, ...branchEdges]
  if (incoming && outgoing) {
    edges.push({
      id: edgeId(incoming.source, outgoing.target, incoming.branch),
      source: incoming.source,
      target: outgoing.target,
      ...(incoming.branch ? { branch: incoming.branch } : {}),
    })
  }

  // 2) Splice after the target (insertNodeAfter's edge logic, existing node).
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(nodeId, old.target), source: nodeId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, nodeId), source: afterId, target: nodeId })
  return { ...graph, edges }
}

/** Reorder a loop body (or one parallel branch) by index. Out-of-range no-ops. */
export function moveContainerStep(graph: FlowGraph, containerId: string, from: number, to: number, branchIndex?: number): FlowGraph {
  const container = graph.nodes.find((n) => n.id === containerId)
  if (!container) return graph
  const reorder = (list: string[]): string[] | null => {
    if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return null
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  }
  if (container.type === 'loop') {
    const next = reorder(container.data.body)
    if (!next) return graph
    return updateNode(graph, { ...container, data: { ...container.data, body: next } })
  }
  if (container.type === 'parallel' && branchIndex !== undefined) {
    const branch = container.data.branches[branchIndex]
    if (!branch) return graph
    const next = reorder(branch)
    if (!next) return graph
    const branches = container.data.branches.map((b, i) => (i === branchIndex ? next : b))
    return updateNode(graph, { ...container, data: { ...container.data, branches } })
  }
  return graph
}

/** Validate clipboard content into a paste-safe step (never a trigger; containers emptied). */
export function sanitizeCopiedNode(raw: unknown): FlowNode | null {
  const parsed = flowNodeSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type === 'trigger') return null
  const node = parsed.data
  if (node.type === 'loop') return { ...node, data: { ...node.data, body: [] } }
  if (node.type === 'parallel') return { ...node, data: { ...node.data, branches: [] } }
  return node
}

/** Paste a sanitized copied step immediately after `afterId` with a fresh id. */
export function pasteNodeAfter(graph: FlowGraph, afterId: string, copied: FlowNode): { graph: FlowGraph; nodeId: string } {
  const copyId = newNodeId(graph)
  const copy = { id: copyId, type: copied.type, data: JSON.parse(JSON.stringify(copied.data)) } as FlowNode
  const edges = [...graph.edges]
  const idx = edges.findIndex((edge) => edge.source === afterId && !edge.branch)
  if (idx >= 0) {
    const old = edges[idx]
    edges[idx] = { id: edgeId(copyId, old.target), source: copyId, target: old.target }
  }
  edges.push({ id: edgeId(afterId, copyId), source: afterId, target: copyId })
  return { graph: { nodes: [...graph.nodes, copy], edges }, nodeId: copyId }
}
```

- [ ] **Step 4: Run tests, full suite, commit**

`npx tsx --test src/lib/flows/__tests__/mutate.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/mutate.ts src/lib/flows/__tests__/mutate.test.ts
git commit -m "feat(flows): move, container-reorder, and paste graph mutations"
```

---

### Task 3: FlowPicker component

**Files:**
- Create: `src/components/flows/flow-picker.tsx`
- Modify: `src/components/flows/flow-canvas.tsx` (InsertMenu popover content → FlowPicker; trigger-mode entry)

**Interfaces:**
- Consumes: Task 1 manifest; existing `agents`/`toolCatalog` props; `onPick(type, seed)` and (new) `onPickTrigger(triggerType)`.
- Produces:

```ts
export function FlowPicker(props: {
  mode: 'action' | 'trigger'
  agents: { id: string; title: string }[]
  toolCatalog: ToolCatalog
  onPick: (type: StepType, seed?: FlowInsertSeed) => void
  onPickTrigger?: (triggerType: 'manual' | 'schedule' | 'webhook' | 'signal') => void
  onClose: () => void
})
```

- [ ] **Step 1: Build FlowPicker**

Create `src/components/flows/flow-picker.tsx` implementing, in one scrollable panel body (the popover shell stays in InsertMenu):

- Header: title `Add an action` / `Add a trigger`; when drilled into a group, breadcrumb `Add an action › <group.label>` with a back chevron button resetting drill state.
- Search input (autoFocus) filtering EVERYTHING (leaves via `searchCorpus`, agents by title, connections by name, connection tools by name+description); non-empty search flattens to grouped result lists and disables drill-in.
- **Favorites** section: star toggle on every leaf/agent/connection-tool row (`Star` icon, filled when favorited); ids persisted to localStorage `flows.pickerFavorites.v1` (agents as `agent:<id>`, connector tools as `tool:<connectionId>:<toolName>`, leaves by their manifest id); section lists favorited items first and hides when empty.
- **AI capabilities** (action mode): `AI_CAPABILITY_LEAVES` + one row per agent (`Bot` icon, pick → `onPick('agent', { agentId })`).
- **Built-in tools**: `BUILTIN_GROUPS` (mode-filtered) as drill-in rows (chevron); clicking a group shows only its children; clicking a child → `onPick(child.stepType!, child.seed)`.
- **Triggers** (trigger mode): `TRIGGER_LEAVES` rows → `onPickTrigger?.(leaf.triggerType!)`.
- **By connector** (action mode): filter chips `All` / `Built-in` / `Connected` (`Built-in` shows only BUILTIN_GROUPS, `Connected` only MCP connections, `All` both); one row per `toolCatalog` connection (reuse `IntegrationLogo`) drilling into its tools (name + description) → `onPick('tool', { connectionId, toolName, label: tool.name })`. Empty catalog: keep the existing dashed empty-state copy.
- Picking anything calls `onClose()` after `onPick`.
- Styling: reuse InsertMenu's current row/card classes (read them; the panel content should look like today's sections, upgraded with drill-in + stars + chips).

- [ ] **Step 2: Wire into the canvas**

In `src/components/flows/flow-canvas.tsx`:
- InsertMenu keeps its button + popover shell + open/close state; its popover CONTENT becomes `<FlowPicker mode="action" agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => { setOpen(false); setQuery?; onPick(type, seed) }} onClose={() => setOpen(false)} />` — delete the now-unused inline `PickerItem`/`BUILT_IN_ITEMS`/`PickerSection`/`matchesQuery` code from this file (FlowPicker owns it).
- Trigger mode: `FlowCanvas` gains optional `onPickTrigger?: (t: 'manual' | 'schedule' | 'webhook' | 'signal') => void`. When the flow has no steps (`trigger && !first`), render under the trigger card a bordered panel `<FlowPicker mode="trigger" …/>` (always visible in the empty state, replacing nothing — the existing tail ⊕ stays for adding the first action). The page (Task 5 wiring below happens there too) implements `onPickTrigger` by updating the trigger node's `data.trigger.type` (preserving other trigger fields) via `updateNode` + selecting the trigger.

- [ ] **Step 3: Verify and commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/flow-picker.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): MS-style add-action/trigger picker — search, favorites, drill-in, connectors"
```

(include the page file only if `onPickTrigger` wiring landed there in this task; otherwise wire it here and now — the trigger update snippet:)

```tsx
            onPickTrigger={(type) => {
              const triggerNode = graph.nodes.find((n) => n.type === 'trigger')
              if (!triggerNode || triggerNode.type !== 'trigger') return
              const current = isRecordLike(triggerNode.data.trigger) ? triggerNode.data.trigger : {}
              commitGraph(updateNode(graph, { ...triggerNode, data: { trigger: { ...current, type } } }))
              setSelectedId(triggerNode.id)
            }}
```

(`isRecordLike` = the local record check; reuse/inline as fits the file.)

---

### Task 4: Canvas rail — zoom, fit, search-in-flow

**Files:**
- Create: `src/components/flows/canvas-rail.tsx`
- Modify: `src/components/flows/flow-canvas.tsx` (add `data-node-id` on each card wrapper)
- Modify: `src/app/flows/[id]/page.tsx` (zoom state + rail mount + scale wrapper)

**Interfaces:**
- Produces: `CanvasRail({ zoom, onZoom, onFit, nodes, onJump }: { zoom: number; onZoom: (z: number) => void; onFit: () => void; nodes: { id: string; title: string }[]; onJump: (id: string) => void })`.

- [ ] **Step 1: CanvasRail component**

Create `src/components/flows/canvas-rail.tsx`: a vertical floating rail (absolute, left-4 bottom-6 — inside the canvas scroll container, `z-10`) of icon buttons styled like the MS reference (white bg, border, shadow, 9×9 rounded buttons stacked with dividers): `ZoomIn` (+0.1), `ZoomOut` (−0.1), `Maximize2` (fit → `onFit`), `Search` toggling an inline popover (input filtering `nodes` by title; clicking a result → `onJump(id)` and closes). Clamp display: show `Math.round(zoom * 100)%` as a tiny label between the zoom buttons. All buttons `stopPropagation` on click (canvas background deselect exists).

- [ ] **Step 2: Wire zoom + jump in the page**

In `src/app/flows/[id]/page.tsx`:
- State: `const [zoom, setZoom] = useState(() => { … localStorage 'flows.canvasZoom', clamp 0.5–1.5, default 1 })`; setter persists.
- Wrap `<FlowCanvas …/>` in a scale div inside the existing scroll container:

```tsx
          <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', width: `${100 / zoom}%`, marginLeft: `${(1 - 1 / zoom) * 50}%` }}>
            <FlowCanvas … />
          </div>
```

- Mount `<CanvasRail zoom={zoom} onZoom={…clamped setZoom…} onFit={() => { setZoom(1); scroll container to top }} nodes={graph.nodes.filter((n) => n.type !== 'trigger').map(...titles via the same labelForNode helper used by RunPanel…)} onJump={(id) => { setSelectedId(id); document.querySelector(`[data-node-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }} />` — the canvas scroll container div needs `className="relative …"` added so the rail anchors to it.

- In `flow-canvas.tsx`'s `card(...)` helper: wrap the `StepCard` in `<div data-node-id={node.id}>…</div>` (or add the attribute to an existing wrapper if one exists per card).

- [ ] **Step 3: Verify and commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/canvas-rail.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): canvas rail — zoom, fit view, search-in-flow"
```

---

### Task 5: Drag-to-reorder

**Files:**
- Modify: `src/components/flows/step-card.tsx` (drag handle)
- Modify: `src/components/flows/flow-canvas.tsx` (drop zones on connectors; drag state)
- Modify: `src/app/flows/[id]/page.tsx` (onMoveAfter / onReorderContainer)

**Interfaces:**
- Consumes: `moveNodeAfter`, `moveContainerStep` (Task 2).
- Produces: `FlowCanvas` props `onMoveAfter?: (nodeId: string, afterId: string) => void`, `onReorderContainer?: (containerId: string, from: number, to: number, branchIndex?: number) => void`; `StepCard` props `draggable?: boolean`, `onDragStartNode?: (id: string) => void`, `onDragEndNode?: () => void`.

- [ ] **Step 1: Drag source on the card**

In `step-card.tsx`: the leading icon `<span>` becomes the grip — when `draggable` prop is true (canvas passes `node.type !== 'trigger'`), set on it `draggable`, `onDragStart={(e) => { e.dataTransfer.setData('text/flow-node-id', node.id); e.dataTransfer.effectAllowed = 'move'; onDragStartNode?.(node.id) }}`, `onDragEnd={() => onDragEndNode?.()}`, `className={cn(existing, draggable && 'cursor-grab active:cursor-grabbing')}`, `title="Drag to reorder"`.

- [ ] **Step 2: Drop zones + spine wiring**

In `flow-canvas.tsx`:
- Local state `const [dragId, setDragId] = useState<string | null>(null)`; `card(...)` passes `draggable={node.type !== 'trigger'}`, `onDragStartNode={setDragId}`, `onDragEndNode={() => setDragId(null)}`.
- The non-compact `InsertMenu` (each connector between/after cards) gains drop props from a new optional prop `dropAfterId?: string` + `onDropNode?: (draggedId: string, afterId: string) => void`: on its wrapper div, when `dragId` (threaded down or via the handlers): `onDragOver={(e) => { if (dropAfterId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}`, `onDrop={(e) => { const id = e.dataTransfer.getData('text/flow-node-id'); if (id && dropAfterId && onDropNode) { e.preventDefault(); onDropNode(id, dropAfterId) } }}`, and a highlight class while `dragId` is set (`ring-2 ring-indigo-300 rounded-full` on the ⊕ button). Call sites pass `dropAfterId` = the id the connector inserts after (they already close over it for `onInsertAfter` — same id).
- `FlowCanvas` threads `onDropNode={(draggedId, afterId) => onMoveAfter?.(draggedId, afterId)}`.
- Container bodies (nestedCards): each nested card wrapper gets `onDragOver`/`onDrop` accepting only sibling ids from the SAME container list; drop computes `from`/`to` indexes and calls `onReorderContainer(containerId, from, to, branchIndex?)`. Look at `nestedCards`' loop — it has the ids array in scope; derive indexes there.
- Page: `onMoveAfter={(nodeId, afterId) => commitGraph(moveNodeAfter(graph, nodeId, afterId))}` and `onReorderContainer={(cid, from, to, bi) => commitGraph(moveContainerStep(graph, cid, from, to, bi))}` (import both).

- [ ] **Step 3: Verify and commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/step-card.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): drag steps to reorder along the spine and inside containers"
```

---

### Task 6: Validation badges + required-field outlines

**Files:**
- Modify: `src/app/flows/[id]/page.tsx` (issuesByNode memo)
- Modify: `src/components/flows/flow-canvas.tsx` (thread `issuesByNode`)
- Modify: `src/components/flows/step-card.tsx` (badge + ring + outline plumbing)

**Interfaces:**
- Produces: `issuesByNode: Record<string, { errors: number; warnings: number; messages: string[] }>` computed from the existing `validation` memo (`validation.issues` items carry `{ level, code, message, nodeId? }`); `StepCard` prop `issues?: { errors: number; warnings: number; messages: string[] }`.

- [ ] **Step 1: Page memo + threading**

```tsx
  const issuesByNode = useMemo(() => {
    const map: Record<string, { errors: number; warnings: number; messages: string[] }> = {}
    for (const issue of validation.issues) {
      if (!issue.nodeId) continue
      const entry = (map[issue.nodeId] ??= { errors: 0, warnings: 0, messages: [] })
      if (issue.level === 'error') entry.errors += 1
      else entry.warnings += 1
      entry.messages.push(issue.message)
    }
    return map
  }, [validation])
```

Pass to `<FlowCanvas issuesByNode={issuesByNode} …/>`; canvas passes `issues={issuesByNode?.[node.id]}` per card.

- [ ] **Step 2: StepCard badge, ring, and outlines**

- Root ring: extend the existing `cn(...)`: when `issues?.errors` and NOT selected → `border-red-400 ring-2 ring-red-100`; warnings only → `border-amber-300`.
- Badge in the header (before the status chip): when `issues` present:

```tsx
        {issues && (issues.errors > 0 || issues.warnings > 0) && (
          <span
            title={issues.messages.slice(0, 3).join('\n')}
            className={cn(
              'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white',
              issues.errors > 0 ? 'bg-red-500' : 'bg-amber-500',
            )}
          >
            {issues.errors + issues.warnings}
          </span>
        )}
```

- Required-field outlines: thread a boolean `showErrors = Boolean(issues?.errors)` into `renderNodeBody` and onto the three bodies with required primaries; in `HttpBody` the URI input, in `AgentBody` the agent `<select>`, in `ToolBody` both selects: append `showErrors && !<value> && 'border-red-400 focus:border-red-500'` to their `className` (value checks: `node.data.url`, `node.data.agentId`, `node.data.connectionId`/`node.data.toolName`).

- [ ] **Step 3: Verify and commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/flows/[id]/page.tsx' src/components/flows/flow-canvas.tsx src/components/flows/step-card.tsx
git commit -m "feat(flows): per-node validation badges, error rings, required-field outlines"
```

---

### Task 7: Keyboard shortcuts + copy/paste

**Files:**
- Create: `src/lib/flows/clipboard.ts`
- Modify: `src/app/flows/[id]/page.tsx`
- Test: `src/lib/flows/__tests__/clipboard.test.ts`

**Interfaces:**
- Consumes: `sanitizeCopiedNode`, `pasteNodeAfter`, `deleteNode` (existing), the page's existing keydown handler pattern.
- Produces: `writeFlowClipboard(node: FlowNode): void` (localStorage `flows.clipboard.v1` + best-effort `navigator.clipboard.writeText(JSON.stringify(node, null, 2))`), `readFlowClipboard(): FlowNode | null` (localStorage → `sanitizeCopiedNode`).

- [ ] **Step 1: Failing tests for the clipboard module** (pure parts; localStorage stubbed)

Create `src/lib/flows/__tests__/clipboard.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFlowClipboard, readFlowClipboard, FLOW_CLIPBOARD_KEY } from '../clipboard'

function stubStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return store
}

test('write/read round-trips a step and sanitizes on read', () => {
  const store = stubStorage()
  writeFlowClipboard({ id: 'a', type: 'stop', data: { reason: 'x' } } as never)
  assert.ok(store.get(FLOW_CLIPBOARD_KEY))
  const read = readFlowClipboard()
  assert.equal(read?.type, 'stop')
})

test('read rejects garbage and triggers', () => {
  const store = stubStorage()
  store.set(FLOW_CLIPBOARD_KEY, 'not json')
  assert.equal(readFlowClipboard(), null)
  store.set(FLOW_CLIPBOARD_KEY, JSON.stringify({ id: 't', type: 'trigger', data: {} }))
  assert.equal(readFlowClipboard(), null)
})
```

- [ ] **Step 2: Run to verify fail**, then implement `src/lib/flows/clipboard.ts`:

```ts
import { sanitizeCopiedNode } from '@/lib/flows/mutate'
import type { FlowNode } from '@/lib/flows/graph'

export const FLOW_CLIPBOARD_KEY = 'flows.clipboard.v1'

/** Persist a copied step (survives reloads and works across flows). */
export function writeFlowClipboard(node: FlowNode): void {
  try {
    localStorage.setItem(FLOW_CLIPBOARD_KEY, JSON.stringify(node))
  } catch {
    /* storage unavailable */
  }
  try {
    void navigator.clipboard?.writeText(JSON.stringify(node, null, 2))
  } catch {
    /* best-effort OS clipboard */
  }
}

/** Read + sanitize the copied step, or null. */
export function readFlowClipboard(): FlowNode | null {
  try {
    const raw = localStorage.getItem(FLOW_CLIPBOARD_KEY)
    if (!raw) return null
    return sanitizeCopiedNode(JSON.parse(raw))
  } catch {
    return null
  }
}
```

(`navigator` may be undefined under node tests — guard with `typeof navigator !== 'undefined'` if the test run complains.)

- [ ] **Step 3: Page shortcuts**

In the page's existing `useEffect` keydown handler (the one handling ⌘Z — extend it, keeping its input-guard):
- `Delete`/`Backspace` (no modifiers): if `selectedId && selectedId !== 'trigger'` → `commitGraph(deleteNode(graph, selectedId)); setSelectedId(null); toast.success('Step deleted — ⌘Z to undo.')`.
- `(meta||ctrl) + c`: if a non-trigger node is selected → `writeFlowClipboard(selectedNode)`, `toast.success('Step copied.')` (do NOT preventDefault when nothing is selected, so normal text copy works).
- `(meta||ctrl) + v`: `const copied = readFlowClipboard()`; if none → return; paste after `selectedId && selectedId !== 'trigger' ? selectedId : <spine tail>` (reuse `spineIds(graph)` — last id, falling back to `'trigger'`), `const { graph: next, nodeId } = pasteNodeAfter(graph, afterId, copied); commitGraph(next); setSelectedId(nodeId); toast.success('Step pasted.')`.
- Update the effect's dependency array for everything referenced.

- [ ] **Step 4: Run everything, commit**

`npx tsx --test src/lib/flows/__tests__/clipboard.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/clipboard.ts src/lib/flows/__tests__/clipboard.test.ts 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): Del/copy/paste keyboard shortcuts with cross-flow step clipboard"
```

---

### Task 8: Floating dynamic-content popover

**Files:**
- Modify: `src/components/flows/step-card.tsx`

**Interfaces:**
- Consumes: the existing `tokenTargetRef`/`registerTokenTarget` machinery, `DataTree`, `insertToken`.
- Produces: visual change only — the DataTree renders in a `createPortal` popover anchored to the focused token field instead of a block under the card body.

- [ ] **Step 1: Popover state + anchor**

In `step-card.tsx`:
- Add `const [tokenPopover, setTokenPopover] = useState<{ top: number; left: number; width: number } | null>(null)`.
- In `registerTokenTarget`'s returned focus handler, after storing the target: compute `const rect = event.currentTarget.getBoundingClientRect()` and `setTokenPopover({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 380), width: Math.max(320, Math.min(rect.width, 420)) })` — only when `selected && dataFields && dataFields.length > 0`.
- Close conditions: `useEffect` adding a `mousedown` listener that closes unless the click is inside the popover (`ref` check) or on the anchor field; also close on `Escape`, on `selected` becoming false, and on card scroll (`window` `scroll` capture listener → close; simple + avoids stale positioning).

- [ ] **Step 2: Portal render + removal of the old block**

- Replace the current below-body block (`{dataFields && dataFields.length > 0 && (<div className="mt-4 border-t …"><DataTree …/></div>)}` inside the expanded body) with nothing there, and render at the card root's end:

```tsx
      {selected && tokenPopover && dataFields && dataFields.length > 0 &&
        createPortal(
          <div
            ref={tokenPopoverRef}
            style={{ position: 'fixed', top: tokenPopover.top, left: tokenPopover.left, width: tokenPopover.width, zIndex: 60 }}
            className="max-h-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <DataTree fields={dataFields} onInsert={insertToken} title="Insert data" emptyMessage="No earlier step data is available yet." />
          </div>,
          document.body,
        )}
```

- `import { createPortal } from 'react-dom'`; `const tokenPopoverRef = useRef<HTMLDivElement | null>(null)`.
- The DataTree's insert buttons already `preventDefault` on mousedown (keeps field focus) — verify that still holds through the portal.

- [ ] **Step 3: Verify and commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/step-card.tsx
git commit -m "feat(flows): dynamic-content popover floats beside the focused field"
```

---

### Task 9: Final verification

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test` — all green.
- [ ] **Step 2:** Reasoning smoke checklist: picker drill-in/back + search + stars persist; trigger picker sets type and keeps existing trigger fields; zoom persists + fit resets + search jumps and selects; dragging the grip highlights connectors and reordering commits (undo-able); trigger undraggable; error badge counts match the banner; Del/⌘C/⌘V guarded while typing; paste lands after selection with fresh id; token popover follows the focused field and Escape closes it.
