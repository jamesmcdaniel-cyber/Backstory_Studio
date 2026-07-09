# WS7: Plain-English Tokens + Actionable Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 7: eliminate raw `{{token}}` syntax from every user-facing surface (inputs become chip editors, read surfaces humanize) and make validation badges/drawer explain issues in plain English.

**Architecture:** A pure, tested helper module (`src/lib/flows/token-text.ts`) owns parsing `{{...}}` strings into segments and resolving plain-English labels from the flow graph. A `TokenTextEditor` contentEditable component renders segments as text + atomic chips and serializes back to the canonical storage string (graph JSON format NEVER changes). The drawer/tool-args editors adopt it; step cards humanize summaries; the validation badge gains a message popover and the drawer an issue banner.

**Tech Stack:** React 18 client components, Tailwind, zod-free pure TS helpers, node:test.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent. Baseline at plan time: 389 pass / 6 skip, 4 pre-existing lint warnings. Never run dev/build/prisma locally; before push run the CI-mode gate (see ledger).
- Storage format is UNTOUCHED: graph JSON keeps `{{...}}` tokens exactly as today. Only presentation changes. Interpreter (`interpret.ts`), validator, copilot routes: no behavior changes.
- Token grammar (from `src/lib/flows/datatree.ts` + interpreter): `{{trigger.input}}`, `{{trigger.input.<path>}}`, `{{step.<id>.output}}`, `{{step.<id>.output.<path>}}`, `{{item}}`, `{{item.<path>}}`, `{{loop.index}}`; path segments may be numeric (array index).
- Label rules: `trigger.input` → `Run input`; `step.<id>.output` → the step's label (fallback `Step <id>`); `item` → `Current item`; `loop.index` → `Item number`; nested paths append ` › <segment>` per segment; numeric segment `N` renders `item N+1` (e.g. `.0` → ` › item 1`). Unknown/unparseable paths render the raw inner path (still no braces).
- Chip visual: `inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700 border border-indigo-200` (dark-variant consistent with neighboring components if they carry dark: classes; check `data-tree.tsx`).
- No user-visible `{{` anywhere after WS7: inputs, placeholders, helper copy, card summaries, KV editors, signal helper text (`step-drawer.tsx:1039`).

---

### Task 1: token-text pure helpers (TDD)

**Files:**
- Create: `src/lib/flows/token-text.ts`
- Test: `src/lib/flows/__tests__/token-text.test.ts`

**Interfaces (Produces):**

```ts
export type TokenSegment = { kind: 'text', value: string } | { kind: 'token', path: string }
export type TokenLabelContext = { stepLabels: Record<string, string> }
export function parseTokenSegments(value: string): TokenSegment[]
export function serializeTokenSegments(segments: TokenSegment[]): string
export function friendlyTokenLabel(path: string, ctx: TokenLabelContext): string
export function humanizeTokens(value: string, ctx: TokenLabelContext): string
export function stepLabelsOf(graph: FlowGraph, agents?: { id: string, title: string }[]): Record<string, string>
```

Semantics:
- `parseTokenSegments`: split on `/\{\{\s*([^{}]+?)\s*\}\}/g`; token `path` is the trimmed inner text; adjacent text preserved verbatim; empty string → `[]`; `serializeTokenSegments(parseTokenSegments(v)) === v` for canonical inputs (tokens re-emit as `{{path}}` with no padding — document that `{{ x }}` normalizes to `{{x}}`).
- `friendlyTokenLabel`: per Global Constraints label rules.
- `humanizeTokens`: replace each token with its friendly label (plain text, no braces).
- `stepLabelsOf`: node label resolution matching the builder's `labelForNode` behavior: agent node → `data.label || agents.find(a => a.id === data.agentId)?.title || 'Agent step'`; other nodes → `data.label ||` capitalized type. Trigger excluded.

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenSegments, serializeTokenSegments, friendlyTokenLabel, humanizeTokens, stepLabelsOf } from '../token-text'
import { emptyGraph } from '../graph'
import { insertNodeAfter } from '../mutate'

const ctx = { stepLabels: { n1: 'Score each', n2: 'Pull accounts' } }

test('parseTokenSegments splits text and tokens, trims token padding', () => {
  assert.deepEqual(parseTokenSegments('Scorecards: {{step.n1.output}} done'), [
    { kind: 'text', value: 'Scorecards: ' },
    { kind: 'token', path: 'step.n1.output' },
    { kind: 'text', value: ' done' },
  ])
  assert.deepEqual(parseTokenSegments('{{ trigger.input }}'), [{ kind: 'token', path: 'trigger.input' }])
  assert.deepEqual(parseTokenSegments(''), [])
  assert.deepEqual(parseTokenSegments('no tokens'), [{ kind: 'text', value: 'no tokens' }])
})

test('serialize round-trips canonical strings', () => {
  const v = 'a {{step.n1.output.score}} b {{item}} c'
  assert.equal(serializeTokenSegments(parseTokenSegments(v)), v)
})

test('friendlyTokenLabel maps the grammar to plain english', () => {
  assert.equal(friendlyTokenLabel('trigger.input', ctx), 'Run input')
  assert.equal(friendlyTokenLabel('trigger.input.accountId', ctx), 'Run input › accountId')
  assert.equal(friendlyTokenLabel('step.n1.output', ctx), 'Score each')
  assert.equal(friendlyTokenLabel('step.n1.output.score', ctx), 'Score each › score')
  assert.equal(friendlyTokenLabel('step.n9.output', ctx), 'Step n9')
  assert.equal(friendlyTokenLabel('item', ctx), 'Current item')
  assert.equal(friendlyTokenLabel('item.name', ctx), 'Current item › name')
  assert.equal(friendlyTokenLabel('loop.index', ctx), 'Item number')
  assert.equal(friendlyTokenLabel('step.n1.output.0', ctx), 'Score each › item 1')
  assert.equal(friendlyTokenLabel('totally.unknown', ctx), 'totally.unknown')
})

test('humanizeTokens strips every brace from mixed text', () => {
  const out = humanizeTokens('Scorecards: {{step.n1.output}} and {{trigger.input.accountId}}', ctx)
  assert.equal(out, 'Scorecards: Score each and Run input › accountId')
  assert.equal(out.includes('{{'), false)
})

test('stepLabelsOf resolves agent titles and typed fallbacks', () => {
  let g = emptyGraph()
  const a = insertNodeAfter(g, 'trigger', 'agent')
  g = a.graph
  const h = insertNodeAfter(g, a.nodeId, 'http')
  g = h.graph
  const withAgent = { ...g, nodes: g.nodes.map((n) => (n.id === a.nodeId ? { ...n, data: { ...n.data, agentId: 'ag1' } } : n)) }
  const labels = stepLabelsOf(withAgent as typeof g, [{ id: 'ag1', title: 'Researcher' }])
  assert.equal(labels[a.nodeId], 'Researcher')
  assert.equal(labels[h.nodeId], 'Http')
  assert.equal('trigger' in labels, false)
})
```

- [ ] **Step 2: RED, implement, GREEN** (`npx tsx --test src/lib/flows/__tests__/token-text.test.ts`, then full suite)
- [ ] **Step 3: Commit** `feat(flows): token-text helpers — parse, label, humanize flow tokens`

---

### Task 2: TokenTextEditor chip component

**Files:**
- Create: `src/components/flows/token-text-editor.tsx`

**Interfaces:**
- Consumes: `parseTokenSegments`, `serializeTokenSegments`, `friendlyTokenLabel`, `TokenLabelContext` (Task 1).
- Produces:

```ts
export type TokenTextEditorHandle = { insertToken: (token: string) => void, focus: () => void }
export const TokenTextEditor: ForwardRefExoticComponent<{
  value: string
  onChange: (value: string) => void
  labelCtx: TokenLabelContext
  multiline?: boolean            // false → single-line (input-like, Enter suppressed)
  rows?: number                  // multiline min-height heuristic (default 3)
  placeholder?: string
  className?: string             // appended to the base field styling
  invalid?: boolean              // red border state (replaces showErrors && !value patterns)
  onFocus?: () => void
  ariaLabel?: string
} & RefAttributes<TokenTextEditorHandle>>
```

Implementation contract (this is the hard task — follow exactly):
- contentEditable `div` (`role="textbox"`, `aria-multiline`, `data-placeholder` + CSS `empty:before:content-[attr(data-placeholder)]`-style placeholder using Tailwind arbitrary variants, muted color).
- Render model: text segments as plain text nodes; newline as `<br>`; token segments as `<span contentEditable={false} data-token={path}>` chips showing `friendlyTokenLabel(path, labelCtx)` with the chip styling from Global Constraints. Chips are atomic — contentEditable=false makes selection/backspace treat them as units in modern browsers.
- Serialization: walk `childNodes` recursively — element with `data-token` → `{{path}}`; `<br>` → `\n`; block-level children beyond the first (`div`, `p`) → prefix `\n`; text nodes → text. Export this walker as a pure-ish module function `serializeEditorDom(root: HTMLElement): string` (exported for reuse, logic simple enough that typecheck+manual QA suffice; it takes a DOM node so node:test would need jsdom — skip unit tests, keep it small and obvious).
- Controlled-value sync WITHOUT caret jumps: on `input`, serialize DOM → `onChange(serialized)`; store `lastEmittedRef.current = serialized`. In an effect on `[value]`: if `value !== lastEmittedRef.current`, rebuild innerHTML from `parseTokenSegments(value)` (external change, e.g. undo or copilot edit — caret reset acceptable) and update `lastEmittedRef`.
- `insertToken(token)`: focus the editor; if the current selection is inside the editor use it, else place caret at end; `range.deleteContents()`; insert the chip span + a trailing zero-width-free space text node (`' '`? No — insert plain chip; add a single space text node ONLY if the next sibling is another chip or end-of-content, so typing after insertion is possible); then dispatch the same serialize+onChange path.
- Single-line mode: `keydown` Enter → `preventDefault()`. IME guard: `if (event.nativeEvent.isComposing) return` before the Enter suppression (matches copilot-panel precedent).
- Paste: `onPaste` → `preventDefault()`; take `clipboardData.getData('text/plain')`; if it contains `{{`, parse into segments and insert chips+text at the caret (so pasting a copied template still chips up); else insert plain text. Use `document.execCommand('insertText')` fallback only for the plain path if range insertion is fiddly — but chips path must build nodes manually.
- Styling: base = the drawer's `fieldClass`/`areaClass` look (read them; approximate: `w-full rounded-md border border-input bg-background px-3 py-2 text-sm`), `invalid` → `border-red-400`, multiline → `min-h-[Xpx] whitespace-pre-wrap`, single-line → `whitespace-nowrap overflow-x-auto`.
- NO tests (DOM component; no component-test infra) — but it must typecheck/lint clean and Task 3's adoption is the functional exercise. Keep the file under ~220 lines.

- [ ] **Step 1: Implement the component per contract**
- [ ] **Step 2: `npm run typecheck && npm run lint && npm test` (389/6 baseline holds)**
- [ ] **Step 3: Commit** `feat(flows): TokenTextEditor — plain-english chip editor over {{token}} storage`

---

### Task 3: Adopt the chip editor everywhere tokens are typed

**Files:**
- Modify: `src/components/flows/step-drawer.tsx`
- Modify: `src/components/flows/tool-args-editor.tsx`
- Modify: `src/components/flows/advanced-params.tsx` (check for token-accepting fields / placeholder copy)

**Interfaces:**
- Consumes: `TokenTextEditor`, `TokenTextEditorHandle` (Task 2), `stepLabelsOf` (Task 1).
- Produces: `StepDrawer` gains prop `labelCtx: TokenLabelContext` (page provides `useMemo(() => ({ stepLabels: stepLabelsOf(graph, agents) }), [graph, agents])` — pass through flow-canvas the same way `dataFields` flows: canvas → drawer render site; find where StepDrawer is rendered in `page.tsx` and thread it there; `tool-args-editor` gains the same prop from the drawer).

Conversion list (every field whose value can contain tokens; each keeps its exact `onChange` data-write and gains `ref` registration so `insertToken` targets the FOCUSED editor):
- agent `input` (Message to agent) — multiline
- http `url` (single-line), http `body` (multiline), http headers KV values (single-line each; find the KV editor)
- tool args editor free-text arg values (`tool-args-editor.tsx` — its `insert` already exists; route through editor refs)
- transform `fields[i].value`, filter/condition clause `left`/`right`, switch case `left`/`right`, loop `over`, stop `reason` if it accepts tokens (check interpreter usage — if not templated, leave as plain input)
- Replace the drawer's `activeField`/`activeAccessor`/`insertAtCaret` machinery: keep `activeField` naming but store `activeEditorRef: MutableRefObject<TokenTextEditorHandle | null>` set via each editor's `onFocus`; `insertToken(token)` becomes `activeEditorRef.current?.insertToken(token)` with the OLD string-append fallback removed. Delete `src/components/flows/insert-token.ts` usage from the drawer if nothing else imports it (grep first — step-card.tsx also imports insertToken helpers for the card-level token popover; that's Task 4's concern, don't break it here).
- Placeholder/copy sweep in these files: no `{{` anywhere user-visible. `valuePlaceholder="{{trigger.input.accountId}}"` → `"Click a value from Available data"`; http body placeholder → `'{"text": "Use a value from Available data"}'` stays (it's JSON syntax, not a token) but the text-mode one loses the `{{trigger.input.message}}` example; `step-drawer.tsx:1039` signal copy `{'{{trigger.input}}'}` → `the Run input`.

- [ ] **Step 1: Thread `labelCtx` from page → canvas/drawer render site → StepDrawer → ToolArgsEditor**
- [ ] **Step 2: Convert the fields per the list; rewire insertToken; sweep placeholders**
- [ ] **Step 3: `npm run typecheck && npm run lint && npm test` (baseline holds)**
- [ ] **Step 4: Commit** `feat(flows): chip editors across the step drawer — no raw token syntax in inputs`

---

### Task 4: Plain-English tokens on read surfaces

**Files:**
- Modify: `src/components/flows/step-card.tsx`
- Modify: `src/components/flows/flow-canvas.tsx` (thread `labelCtx` down; it already threads `dataFields`)

**Interfaces:**
- Consumes: `humanizeTokens`, `TokenLabelContext` (Task 1). `StepCard` gains optional `labelCtx?: TokenLabelContext`.

Work:
- Find every place step-card renders node data that can contain tokens (collapsed summary line(s): agent input preview, http url, loop over, condition/switch clause previews — grep for `data.input`, `data.url`, `data.over`, clause rendering) and wrap with `humanizeTokens(value, labelCtx)` when `labelCtx` present.
- The card's inline token-insert popover (`DataTree` via createPortal) stays (it inserts into drawer-owned fields? verify — if it splices raw tokens into node data directly via `insertToken` from `insert-token.ts`, route the CARD's insert through the same string helper as before — storage format unchanged, display humanized; do NOT convert card inline editing to chip editors in this task).
- Any tooltip/title attributes on cards echoing raw values: humanize those too.

- [ ] **Step 1: Implement + sweep step-card for `{{` leaks (grep the rendered-string sites)**
- [ ] **Step 2: Verify + baseline**
- [ ] **Step 3: Commit** `feat(flows): humanized token display on step cards`

---

### Task 5: Actionable validation — badge popover + drawer issue banner

**Files:**
- Modify: `src/components/flows/step-card.tsx` (badge popover)
- Modify: `src/components/flows/step-drawer.tsx` (issue banner)
- Modify: `src/app/flows/[id]/page.tsx` (pass full issue lists to the drawer; verify card already gets full messages)

**Interfaces:**
- Consumes: existing `issues` prop on StepCard (`{ errors: number, warnings: number, messages: string[] }` — extend to `{ errors, warnings, items: { level: 'error' | 'warning', message: string }[] }`; update the page's `issuesByNode` memo to provide items and keep `messages` derivable or migrate both call sites). `StepDrawer` gains `issues?: { level: 'error' | 'warning', message: string }[]`.

Work:
- **Badge popover:** the count badge becomes a button (`aria-label="Show issues"`); click toggles a popover (same createPortal pattern as the card's token popover — reuse its positioning helper) listing each issue: red dot + message for errors, amber for warnings, errors first; footer button `Fix in settings` → calls the existing `onOpenSettings` (verify the card's prop name; the ⋯ menu uses it) and closes. Remove the old `title` attribute (replaced by the popover). Outside-click and Escape close it.
- **Drawer banner:** at the top of the drawer body (below the header, above fields), when `issues?.length`: a `rounded-md border border-red-200 bg-red-50 p-3` block (amber variants when only warnings) listing the messages with the same dot treatment. No dismiss — it disappears when the issues are fixed (live `issuesByNode` recompute already exists).
- Page: extend `issuesByNode` memo to `{ errors, warnings, items }`, update StepCard usage, pass `issues={selectedId ? issuesByNode[selectedId]?.items : undefined}` to StepDrawer. Version viewing already hides issue overlays (`issuesByNode` gated) — keep that behavior; the drawer is not rendered in version view (verify: `selectedNode && !viewingVersion`).

- [ ] **Step 1: Extend issuesByNode + StepCard issues shape (both call sites) + popover**
- [ ] **Step 2: Drawer banner + page threading**
- [ ] **Step 3: Verify + baseline; Commit** `feat(flows): validation issues readable in place — badge popover + drawer banner`

---

### Task 6: Final verification + whole-workstream review

- [ ] `npm run typecheck && npm run lint && npm test` green at baseline+new tests.
- [ ] Repo-wide leak sweep: `grep -rn '{{' src/components/flows/ src/app/flows/ --include='*.tsx' | grep -v '\.test\.' ` — every remaining hit must be storage/serialization logic or non-user-visible; justify each in the ledger.
- [ ] Final whole-workstream review (most capable model) on the review package; fix Critical/Important; push after the CI-mode gate (DB tests + build vs ci_repro).
