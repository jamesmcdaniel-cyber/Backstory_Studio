# DAG Builder Canvas — Phase 2a Implementation Plan

> **For agentic workers:** implement task-by-task; steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the custom single-spine flow renderer with a React Flow (`@xyflow/react`) canvas of **compact, n8n-style node widgets** (icon + label + side handles) connected by edges, with left-to-right dagre auto-layout and branches drawn as labeled edges — preserving every current builder capability (select→drawer, insert, delete, retype, duplicate, zoom/pan). Phase 2a ships the renderer swap with NO new editing capability; Phase 2b (separate) adds free-form multi-parent drawing.

**Architecture:** The graph schema, validator, and interpreter already support DAGs (Phase 1). Phase 2a rebuilds only the presentation/authoring canvas. Node detail stays in the existing `StepDrawer`; the canvas node is a small widget. Positions are computed by dagre from edge topology and persisted on an optional `node.position`. The new canvas lives behind a feature flag so the existing builder keeps working until the new one is preview-verified.

**Tech Stack:** Next.js, React, `@xyflow/react` (React Flow v12), `dagre` for layout, Zod graph schema, Tailwind. Verification note: the dev server 500s locally (no Supabase env), so **visual verification is on a Vercel preview**; all logic (schema/layout/mutations) is unit-tested with `node:test`, and everything stays typecheck/lint/build-clean.

## Global Constraints

- The existing builder MUST keep working throughout: the React Flow canvas is introduced behind a flag (`NEXT_PUBLIC_FLOW_CANVAS_V2` / a builder toggle), not by deleting `flow-canvas.tsx`.
- No engine/validator changes — Phase 1 already supports fan-in. Phase 2a is presentation + a position field + read-only-friendly edge model.
- Branches render as labeled edges (Condition `true`/`false`, Switch case ids/`default`, `error`), not nested boxes.
- Containers (`loop`/`parallel`) stay single nodes; their bodies are edited in the drawer (unchanged), shown on the widget as a small "N steps" badge.
- Verify per task: `npx tsc --noEmit` clean, `npm run lint` 0 errors, named tests pass. Final task: full suite + CI-mode build.

## File Structure

- `src/lib/flows/graph.ts` — MODIFY: add optional `position: {x,y}` to node schema.
- `src/lib/flows/layout.ts` — CREATE: pure dagre layout (`layoutGraph(graph) → Map<nodeId,{x,y}>`), LR, container-aware.
- `src/lib/flows/__tests__/layout.test.ts` — CREATE.
- `src/lib/flows/mutate.ts` — MODIFY: add `addEdge`/`removeEdge`/`setNodePositions`; make `deleteNode` fan-in/out-safe.
- `src/lib/flows/__tests__/mutate.test.ts` — MODIFY (append): edge-CRUD + fan-in-safe delete.
- `src/components/flows/canvas/flow-canvas-v2.tsx` — CREATE: the React Flow canvas.
- `src/components/flows/canvas/step-node.tsx` — CREATE: the compact n8n-style node widget.
- `src/components/flows/canvas/graph-to-flow.ts` — CREATE + test: pure map from `FlowGraph` → React Flow `{nodes, edges}` (branch handles/labels), so the visual layer is thin.
- `src/components/flows/canvas/__tests__/graph-to-flow.test.ts` — CREATE.
- `src/app/flows/[id]/page.tsx` — MODIFY: mount v2 canvas behind the flag; reuse existing handlers.

## Tasks (summary — detailed steps authored per task at execution time)

1. **Deps + `node.position` schema** — add `@xyflow/react`, `dagre`, `@types/dagre`; optional `position` on the node schema (back-compat: absent = auto-layout). Test: schema parses with/without position.
2. **Pure dagre layout** (`layout.ts`) — LR ranking over the outer DAG (container bodies excluded), returns positions; deterministic. Tested on linear, fan-in, branch graphs.
3. **`graph-to-flow.ts`** — pure transform: FlowGraph → RF nodes (type `step`, data = node + label/subtitle/status) + RF edges (source/target, `sourceHandle` = branch, edge `label` for branch names). Tested (fan-in yields 2 edges into one target; condition yields 2 labeled edges).
4. **mutate edge-CRUD + fan-in-safe delete** — `addEdge(source,target,branch?)` (dedupe, no self, no cycle via `findCycle`), `removeEdge(id)`, `setNodePositions(map)`; `deleteNode` reconnects ALL parents to ALL children only when unambiguous, else just removes edges (fan-in/out safe). Tested.
5. **Compact node widget** (`step-node.tsx`) — small rounded widget: type icon + label + subtitle + status dot; left target handle; right source handle(s) — one per branch for condition/switch, plus an `error` handle when `onError:route`. Click selects (opens drawer). Container widgets show a "N steps" badge.
6. **`flow-canvas-v2.tsx`** — `<ReactFlow>` with `graph-to-flow` nodes/edges, dagre layout when positions absent, `onNodeClick→onSelect`, `onNodesChange` persists positions (debounced via `setNodePositions`), custom `stepNode` type, `fitView`, controls. Read-only edges in 2a (connection UI is 2b). Insert "+" affordance reused from FlowPicker on node/edge.
7. **Flag-mounted in page + full gates** — render v2 when the flag is on, else the existing canvas; wire existing handlers; typecheck/lint/full suite/CI build; commit + push.
