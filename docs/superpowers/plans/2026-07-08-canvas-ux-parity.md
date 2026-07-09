# Canvas UX Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 1.75 (`docs/superpowers/specs/2026-07-08-flow-parity-design.md`): step cards render collapsed by default and expand only when selected (with animation), the canvas deselects on background click, and node connectors become MS-style arrow lines with a circular ⊕ insert button.

**Architecture:** Pure UI changes in `step-card.tsx`, `flow-canvas.tsx`, and the builder page — no graph/schema/runtime changes. The card's config body becomes conditional on `selected`, wrapped in a `motion/react` height animation; a manual trigger keeps its "+ Add an input" affordance while collapsed. The connector between cards becomes line + ⊕ + line + arrowhead.

**Tech Stack:** React 18, Tailwind, `motion` v12 (`motion/react`, already a dependency, `MotionConfig` provider already mounted), lucide-react.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- No component test infra — verification for every task is `npm run typecheck && npm run lint && npm test` (tests guard the untouched lib modules; expect 291 pass / 6 skip, 4 pre-existing lint warnings in untouched test files).
- Local env has no Supabase vars: never run `npm run dev` / `npm run build`.
- Do not change any prop names existing callers rely on; additions only.
- `motion` imports come from `'motion/react'` (matches `src/components/providers/client-providers.tsx`).
- Reference behavior (spec 1.75): collapsed card = icon + title + subtitle + status + PanelRight/⋯ buttons, NO config body; ONLY the selected card expands; manual-trigger cards may show "+ Add an input" while collapsed; clicking a collapsed card selects+expands it; clicking the canvas background deselects.

---

### Task 1: Collapsed-by-default cards with animated expand + background deselect

**Files:**
- Modify: `src/components/flows/step-card.tsx`
- Modify: `src/components/flows/flow-canvas.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: existing `StepCard` props (`selected`, `onClick`, `dataFields`, …) — no signature changes to StepCard.
- Produces: `FlowCanvas` gains `onBackgroundClick?: () => void`; the page passes `() => setSelectedId(null)`.

- [ ] **Step 1: Make the card body conditional on `selected`, with a motion height animation**

In `src/components/flows/step-card.tsx`:

Add the motion import at the top (after the react import):

```ts
import { AnimatePresence, motion } from 'motion/react'
```

Replace the body container block (currently):

```tsx
      <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-slate-200 px-5 py-4">
        {renderNodeBody({ node, agents, toolCatalog, update, onRefreshAgents, registerTokenTarget })}
        {selected && dataFields && dataFields.length > 0 && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <DataTree
              fields={dataFields}
              onInsert={insertToken}
              title="Insert data from previous steps"
              emptyMessage="No earlier step data is available yet."
            />
          </div>
        )}
      </div>
```

with a collapsed/expanded switch:

```tsx
      <AnimatePresence initial={false}>
        {selected ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-slate-200 px-5 py-4">
              {renderNodeBody({ node, agents, toolCatalog, update, onRefreshAgents, registerTokenTarget })}
              {dataFields && dataFields.length > 0 && (
                <div className="mt-4 border-t border-slate-200 pt-3">
                  <DataTree
                    fields={dataFields}
                    onInsert={insertToken}
                    title="Insert data from previous steps"
                    emptyMessage="No earlier step data is available yet."
                  />
                </div>
              )}
            </div>
          </motion.div>
        ) : (
          collapsedAffordance(node) && (
            <div className="border-t border-slate-200 px-5 py-1.5">{collapsedAffordance(node)}</div>
          )
        )}
      </AnimatePresence>
```

Add the collapsed-affordance helper above `StepCard` (module scope, below `stopEvent`). It keeps the MS behavior where a bare manual trigger still shows its primary affordance while collapsed; the row is non-interactive (`pointer-events-none`) so the click falls through to the card root, which selects + expands:

```tsx
/** The one affordance a collapsed card may keep showing (MS parity). */
function collapsedAffordance(node: FlowNode): React.ReactNode | null {
  if (node.type !== 'trigger') return null
  const trigger = triggerData(node)
  if ((trigger.type ?? 'manual') !== 'manual') return null
  const count = triggerInputFieldsFromTrigger(trigger).length
  return (
    <span className="pointer-events-none flex items-center gap-3 py-2 text-base font-semibold text-slate-700">
      <Plus className="h-5 w-5" />
      {count > 0 ? `${count} input${count === 1 ? '' : 's'} — add another` : 'Add an input'}
    </span>
  )
}
```

Also make the card root's click select AND stop propagation (so it never bubbles to the canvas background handler added in Step 2). Change the root `div`'s `onClick={onClick}` to:

```tsx
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
```

- [ ] **Step 2: Canvas background deselect**

In `src/components/flows/flow-canvas.tsx`:

- Add `onBackgroundClick?: () => void` to `FlowCanvas`'s props (destructure it alongside the others).
- The root wrapper `div` (`className="mx-auto flex w-full max-w-[760px] flex-col items-center py-8"`) gets `onClick={() => onBackgroundClick?.()}`.
- In `InsertMenu`, stop menu interactions from bubbling into the background handler: on the wrapper `div` (`className={cn('relative flex flex-col items-center', compact && 'items-start')}`), add `onClick={(event) => event.stopPropagation()}`.

In `src/app/flows/[id]/page.tsx`, pass the handler to `<FlowCanvas …/>`:

```tsx
            onBackgroundClick={() => setSelectedId(null)}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean; lint 0 errors (4 pre-existing warnings); 291 pass / 6 skip.

Reasoning walk-through to include in the report (no component tests exist):
- Unselected card: no body render (`renderNodeBody` not called), trigger shows the affordance row.
- Click collapsed card → root handler stops propagation, `onClick` selects → body animates open.
- Click empty canvas → background handler fires → `setSelectedId(null)` → selected card animates closed.
- Insert menu open/click → propagation stopped → no deselect.
- The drawer still opens for the selected node (page renders it from `selectedId`, untouched).

- [ ] **Step 4: Commit**

```bash
git add src/components/flows/step-card.tsx src/components/flows/flow-canvas.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): collapse step cards by default, expand selected with animation"
```

---

### Task 2: MS-style connectors — arrow lines with circular ⊕ insert

**Files:**
- Modify: `src/components/flows/flow-canvas.tsx`

**Interfaces:**
- Consumes: existing `InsertMenu` component (its popover content is untouched).
- Produces: visual-only changes; no prop changes.

- [ ] **Step 1: Restyle the non-compact InsertMenu connector**

In `src/components/flows/flow-canvas.tsx`, inside `InsertMenu`'s returned JSX, the non-compact variant currently renders:

```tsx
      {!compact && <div className="h-8 w-px bg-slate-300" />}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Add step"
        className={cn(
          'group flex items-center justify-center border bg-white text-slate-600 shadow-sm transition-all hover:border-blue-400 hover:text-blue-700 hover:shadow-md',
          compact
            ? 'gap-2 rounded-lg border-dashed px-3 py-2 text-sm font-semibold'
            : 'h-9 w-9 rounded-full border-slate-300',
        )}
      >
        <Plus className={cn('h-5 w-5', compact && 'h-4 w-4')} />
        {compact && 'Add a step'}
      </button>
      {!compact && <div className="h-8 w-px bg-slate-300" />}
```

Replace those three elements with (compact branch unchanged, non-compact gains the arrowhead):

```tsx
      {!compact && <div className="h-6 w-px bg-slate-300" />}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Add step"
        className={cn(
          'group flex items-center justify-center border bg-white text-slate-500 shadow-sm transition-all hover:border-blue-400 hover:text-blue-700 hover:shadow-md',
          compact
            ? 'gap-2 rounded-lg border-dashed px-3 py-2 text-sm font-semibold'
            : 'h-8 w-8 rounded-full border-slate-300',
        )}
      >
        <Plus className={cn('h-4 w-4', compact && 'h-4 w-4')} />
        {compact && 'Add a step'}
      </button>
      {!compact && (
        <div className="flex flex-col items-center">
          <div className="h-5 w-px bg-slate-300" />
          <svg width="10" height="6" viewBox="0 0 10 6" className="-mt-px text-slate-400" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
```

- [ ] **Step 2: Give the tail connector (last card → trailing ⊕) the same treatment**

Still in `flow-canvas.tsx`, `renderChain` renders a tail for the last node in a chain:

```tsx
          <div key={`${node.id}-tail`} className="flex flex-col items-center">
            <div className="h-2 w-px bg-slate-300" />
            <InsertMenu compact agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(node.id, type, seed)} />
          </div>
```

Replace with the non-compact circular ⊕ (no arrowhead below, since there is no next card):

```tsx
          <div key={`${node.id}-tail`} className="flex flex-col items-center">
            <div className="h-6 w-px bg-slate-300" />
            <InsertMenu agents={agents} toolCatalog={toolCatalog} onPick={(type, seed) => onInsertAfter(node.id, type, seed)} />
          </div>
```

Note: the non-compact `InsertMenu` draws its own top line and bottom line+arrowhead. To avoid a dangling arrowhead at the very end of the flow, add an optional `tail?: boolean` prop to `InsertMenu`: when `tail` is true, render the button WITHOUT the bottom line/arrowhead block (`{!compact && !tail && (…arrow block…)}`) and WITHOUT the top line (`{!compact && !tail && <div className="h-6 w-px bg-slate-300" />}` stays as-is for non-tail; for tail the outer wrapper above already draws the short top line). Concretely:

- Props: `function InsertMenu({ onPick, agents, toolCatalog, compact, tail }: { …; compact?: boolean; tail?: boolean })`
- Top line condition: `{!compact && !tail && <div className="h-6 w-px bg-slate-300" />}`
- Arrow block condition: `{!compact && !tail && (…svg block…)}`
- The tail call site passes `tail`: `<InsertMenu tail agents={agents} …/>`

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (same counts as Task 1).

```bash
git add src/components/flows/flow-canvas.tsx
git commit -m "feat(flows): MS-style connectors — arrow lines with circular insert button"
```

---

### Task 3: Rotating running-status words (~5s cadence) everywhere agents run

*Added 2026-07-08 at user request: "when the agent is running it should transition words every 5 seconds".*

**Files:**
- Create: `src/components/ui/typewriter-status.tsx`
- Modify: `src/app/dashboard/agent-activity-pane.tsx` (delete the local copy, import the shared one)
- Modify: `src/components/flows/step-card.tsx` (running status chip)
- Modify: `src/components/flows/run-panel.tsx` (running step rows + run header)

**Interfaces:**
- Produces: `TypewriterStatus({ seed?: number })` and `RUNNING_WORDS` exported from `@/components/ui/typewriter-status`.

- [ ] **Step 1: Create the shared component**

Create `src/components/ui/typewriter-status.tsx` by MOVING the existing `RUNNING_WORDS` array and `TypewriterStatus` component verbatim from `src/app/dashboard/agent-activity-pane.tsx` (lines ~92-129), with exactly two changes:
1. Add `'use client'` at the top and the react import: `import { useEffect, useState } from 'react'`.
2. Tune the cadence to ~5 seconds per word: in the `'typing'` phase, change the hold trigger from `window.setTimeout(() => setPhase('holding'), 1100)` to `window.setTimeout(() => setPhase('holding'), 4000)`, and in the `'holding'` phase change `350` to `400`. (Typing ≈ 0.5s + hold 4.4s + delete ≈ 0.3s ≈ 5.2s per word.)

Export both:

```tsx
export const RUNNING_WORDS = [
  'Working', 'Thinking', 'Reasoning', 'Analyzing', 'Pondering', 'Crunching',
  'Synthesizing', 'Digging in', 'Computing', 'Percolating', 'Noodling', 'Cooking',
]

export function TypewriterStatus({ seed = 0 }: { seed?: number }) { … }
```

(The component body is the verbatim move described above; keep the trailing `<span className="animate-pulse">…</span>`.)

- [ ] **Step 2: Swap the dashboard to the shared component**

In `src/app/dashboard/agent-activity-pane.tsx`: delete the local `RUNNING_WORDS` const and `TypewriterStatus` function; add `import { TypewriterStatus } from '@/components/ui/typewriter-status'`. Existing `<TypewriterStatus seed={…} />` call sites in that file stay as-is. Remove `useEffect` from the react import ONLY if nothing else in the file uses it (check first).

- [ ] **Step 3: Use it in the flow builder**

In `src/components/flows/step-card.tsx`, the status chip currently renders the raw status text:

```tsx
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
            {status}
          </span>
        )}
```

Change the text line to:

```tsx
            {status === 'running' ? <TypewriterStatus /> : status}
```

and add the import: `import { TypewriterStatus } from '@/components/ui/typewriter-status'`.

In `src/components/flows/run-panel.tsx`:
- Add the same import.
- `StepRow`'s status span becomes: `{step.status === 'running' ? <TypewriterStatus /> : step.status}` (keep the surrounding span + classes).
- The selected-run header span becomes: `{selected.status === 'running' ? <TypewriterStatus /> : selected.status}` (keep classes).

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean (291 pass / 6 skip; 4 pre-existing warnings).

```bash
git add src/components/ui/typewriter-status.tsx src/app/dashboard/agent-activity-pane.tsx src/components/flows/step-card.tsx src/components/flows/run-panel.tsx
git commit -m "feat: shared 5s typewriter running-status words across dashboard and flow builder"
```

---

### Task 4: Final check

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 2: Reasoning smoke checklist**

Confirm in code:
- Empty flow: trigger card collapsed with "Add an input" affordance; trailing ⊕ with no arrowhead.
- Multi-node flow: connectors read line → ⊕ → line → arrowhead → next card.
- Selecting different cards collapses the previous one (only one `selected` at a time via `selectedId`).
- Branch containers (condition/switch) still render their compact "Add a step" InsertMenus unchanged.
