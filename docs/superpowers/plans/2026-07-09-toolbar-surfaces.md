# WS3: Toolbar Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec section 3 (+ scope addition) of `docs/superpowers/specs/2026-07-08-flow-parity-design.md`: a Flow checker panel (click→jump), a first-class Test panel, Version history (snapshot on publish, view/restore), and an Activity page with run filtering.

**Architecture:** New `FlowVersion` Prisma model written transactionally on publish (hand-authored migration with a backfill INSERT). Three new right-dock panels (checker/test/versions) reuse `ResizablePanel` + the builder's existing state (`validation`, `statusByNode`, run polling, `data-node-id` jump). Version *viewing* renders the historical graph through the existing canvas in a read-only mode (mutation handlers no-op behind a `viewing` flag). The Activity page is a standalone route reusing the runs API with new filter params. One new pure validation warning (`TEXT_AGENT_FIELD_REF`) closes the spec's warnings-tier item.

**Tech Stack:** Prisma 6 (hand-authored migration + backfill), Next.js App Router, existing UI kit + `ResizablePanel`, `node:test`.

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- Tests: `node:test` for lib (`validate` additions); routes/components follow repo convention (typecheck+lint). Baseline 359 pass / 6 skip; 4 pre-existing lint warnings. Never run dev/build/prisma-migrate — migrations are hand-authored SQL applied by `prisma migrate deploy` on Vercel; run `npx prisma generate` after schema edits.
- `[id]` API routes extract ids via `request.nextUrl.pathname.split('/')` and scope by `organizationId` + `agentVisibilityScope(auth.dbUser.id)` exactly like the sibling flow routes.
- Exact values: warning code `TEXT_AGENT_FIELD_REF`; version panel copy `Viewing v<N>`; restore never touches `publishedGraph` (draft only); Activity route `/flows/<id>/activity`; runs filter params `status` (comma-separable), `take` (default 20, max 100), `summary=1` omits step input/output payloads.
- The checker replaces the current inline amber banner in the builder (`Flow checks` block) — banner is removed; "Fix with Copilot" moves into the checker panel.

---

### Task 1: FlowVersion schema + migration + backfill

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_flow_versions/migration.sql`

**Interfaces:**
- Produces: `prisma.flowVersion` with `{ id, flowId, organizationId, version, graph, trigger, note?, publishedAt, publishedBy? }`, `@@unique([flowId, version])`. Tasks 2 & 6 depend on it.

- [ ] **Step 1: Schema**

Add near the `Flow` model (line ~617):

```prisma
model FlowVersion {
  id             String   @id @default(cuid())
  flowId         String
  organizationId String   @db.Uuid
  version        Int
  graph          Json
  trigger        Json
  note           String?
  publishedAt    DateTime @default(now())
  publishedBy    String?

  flow         Flow         @relation(fields: [flowId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([flowId, version])
  @@index([organizationId, flowId])
  @@map("flow_versions")
}
```

Back-relations: `versions FlowVersion[]` on `Flow`; `flowVersions FlowVersion[]` on `Organization`. Verify the `flows` table PK type + org FK conventions from existing migrations (mirror `agent_memories`' conventions; `flows.id` is TEXT cuid, org is UUID).

- [ ] **Step 2: Migration + backfill**

`prisma/migrations/<timestamp>_flow_versions/migration.sql` (timestamp after the latest folder):

```sql
CREATE TABLE "flow_versions" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "graph" JSONB NOT NULL,
  "trigger" JSONB NOT NULL,
  "note" TEXT,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" TEXT,
  CONSTRAINT "flow_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_versions_flowId_version_key" ON "flow_versions"("flowId", "version");
CREATE INDEX "flow_versions_organizationId_flowId_idx" ON "flow_versions"("organizationId", "flowId");

ALTER TABLE "flow_versions"
  ADD CONSTRAINT "flow_versions_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_versions"
  ADD CONSTRAINT "flow_versions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every already-published flow's live version becomes its first
-- recorded snapshot, so Version history is never empty for existing flows.
INSERT INTO "flow_versions" ("id", "flowId", "organizationId", "version", "graph", "trigger", "publishedAt", "publishedBy")
SELECT
  'fv_' || md5(random()::text || clock_timestamp()::text),
  f."id", f."organizationId", f."version", f."publishedGraph", f."trigger",
  COALESCE(f."updatedAt", CURRENT_TIMESTAMP), f."userId"
FROM "flows" f
WHERE f."publishedGraph" IS NOT NULL;
```

Adjust column names/types ONLY after checking the real `flows` table columns (`grep -n 'model Flow ' -A 25 prisma/schema.prisma` — confirm `userId`, `updatedAt`, JSONB conventions from the flows-creating migration).

- [ ] **Step 3: Generate + verify + commit**

`npx prisma generate && npm run typecheck && npm run lint && npm test`

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(flows): FlowVersion model with publish-history backfill"
```

---

### Task 2: Publish snapshots + versions API

**Files:**
- Modify: `src/app/api/flows/[id]/publish/route.ts`
- Create: `src/app/api/flows/[id]/versions/route.ts`

**Interfaces:**
- Produces: publish writes a `FlowVersion` row transactionally; `GET /api/flows/<id>/versions` → `{ success, versions: [{ id, version, note, publishedAt, publishedBy }] }` (newest first, take 50, NO graph payloads); `POST /api/flows/<id>/versions` body `{ version: number, action: 'restore' }` → copies that version's graph into the flow's DRAFT (`graph`), returns `{ success, flow }` (serializeFlow) — `publishedGraph` untouched. Extra: `GET …/versions?version=N` returns `{ success, version: { …, graph } }` (single, with graph) for the view overlay.

- [ ] **Step 1: Publish writes the snapshot**

In the publish route's non-revert path, replace the single `prisma.flow.update` with a `$transaction` that (a) updates the flow exactly as today, then (b) creates the snapshot:

```ts
  const [flow] = await prisma.$transaction([
    prisma.flow.update({
      where: { id },
      data: {
        trigger: jsonValue(preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger)),
        publishedGraph: existing.graph ?? {},
        version: { increment: 1 },
      },
    }),
  ])
  await prisma.flowVersion.create({
    data: {
      flowId: id,
      organizationId: auth.organizationId,
      version: flow.version,
      graph: jsonValue(existing.graph ?? {}),
      trigger: jsonValue(flow.trigger),
      publishedBy: auth.dbUser.id,
    },
  }).catch(() => undefined) // snapshot is best-effort; publish itself must not fail on it
```

(If a true single transaction is preferred, `create` can't know `flow.version` beforehand — compute `nextVersion = existing.version + 1` and put BOTH writes in one `$transaction` array using `nextVersion`; do it that way and skip the catch: snapshot integrity > best-effort. Choose the transactional variant.)

- [ ] **Step 2: Versions route**

Create `src/app/api/flows/[id]/versions/route.ts` — id is `.at(-2)`; ownership check identical to the runs route (findFirst flow with org + visibility scope, 404 otherwise):
- GET without `version` param: `prisma.flowVersion.findMany({ where: { flowId: id, organizationId }, orderBy: { version: 'desc' }, take: 50, select: { id, version, note, publishedAt, publishedBy } })`.
- GET with `?version=N`: findFirst incl. `graph`; 404 when absent → `{ success: true, version: row }`.
- POST `{ version: z.number().int().positive(), action: z.literal('restore') }`: load the row (404 if missing), `prisma.flow.update({ where: { id }, data: { graph: row.graph } })`, return `{ success: true, flow: serializeFlow(updated) }`.

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/api/flows/[id]/publish/route.ts' 'src/app/api/flows/[id]/versions/route.ts'
git commit -m "feat(flows): publish snapshots + version list/view/restore API"
```

---

### Task 3: TEXT_AGENT_FIELD_REF warning

**Files:**
- Modify: `src/lib/flows/validate.ts`
- Test: `src/lib/flows/__tests__/validate.test.ts` (append)

**Interfaces:**
- Produces: a `warning`-level issue `TEXT_AGENT_FIELD_REF` on the REFERENCING node when any of its string data fields contains `{{step.<agentId>.output.<field>}}` where `<agentId>` is an agent node that is NOT structured (`responseFormat !== 'structured'` or no non-blank `outputFields` names). Message: `` `${nodeLabel(referencing)} maps a field from ${nodeLabel(agent)}, but that agent returns plain text — switch its response to Structured.` `` — at most one warning per referencing node.

- [ ] **Step 1: Failing tests**

Append to `src/lib/flows/__tests__/validate.test.ts` (match the file's existing builders/imports):

```ts
test('warns when a step maps fields from a text-only agent', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: 'score: {{step.a1.output.score}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  })
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.ok(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF' && w.nodeId === 'h1'))
})

test('no field-ref warning for structured agents or whole-output references', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: '{{step.a1.output.score}} and {{step.a1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  })
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.equal(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF'), false)
})
```

- [ ] **Step 2: RED**, then implement in `validate.ts`: a helper walking every node's string data values (JSON.stringify(node.data) is acceptable for scanning) with `/\{\{\s*step\.([^.}\s]+)\.output\.([^}\s]+)\s*\}\}/g`; for each match resolve the target node; when it's an agent with `responseFormat !== 'structured'` or no non-blank `outputFields[].name` → add the warning once per referencing node (`Set` of flagged ids). Place it with the other per-node checks; reuse `add(issues, 'warning', …)` + `nodeLabel`.

- [ ] **Step 3: GREEN + full suite + commit**

`npx tsx --test src/lib/flows/__tests__/validate.test.ts && npm run typecheck && npm run lint && npm test`

```bash
git add src/lib/flows/validate.ts src/lib/flows/__tests__/validate.test.ts
git commit -m "feat(flows): warn when steps map fields from text-only agents"
```

---

### Task 4: Flow checker panel

**Files:**
- Create: `src/components/flows/checker-panel.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: the page's `validation` memo (`FlowValidationResult`: `errors`/`warnings` arrays of `{ level, code, message, nodeId? }`), the rail's jump pattern (`data-node-id` + `scrollIntoView` + `setSelectedId`), `fixWithCopilot`/`fixing` (existing).
- Produces: `CheckerPanel({ validation, onJump, onFixWithCopilot, fixing, onClose }: { validation: FlowValidationResult; onJump: (nodeId: string) => void; onFixWithCopilot: () => void; fixing: boolean; onClose: () => void })`.

- [ ] **Step 1: Component**

`checker-panel.tsx` styled like `run-panel.tsx` (header + close, scrollable body):
- Header `Flow checker` + a summary line (`N errors · M warnings` or a green `All checks pass` state with a check icon).
- Sections `Errors` (red) and `Warnings` (amber): one row per issue — level dot, message, and when `nodeId` present the row is a button calling `onJump(nodeId)` (hover affordance + `ChevronRight`). Issues without nodeId render as plain rows.
- Footer: the `Fix with Copilot` button (Sparkles, disabled while `fixing`, hidden when zero issues).

- [ ] **Step 2: Page wiring**

- State `const [showChecker, setShowChecker] = useState(false)`.
- Toolbar: replace the `Runs`-style buttons area with an added checker button BEFORE Save: icon `ShieldCheck` (or `ListChecks` twin — pick one not already used), label `Checker`, and a count badge when `validation.errors.length > 0` (red) or warnings (amber): reuse the `Badge` component inline.
- REMOVE the inline amber `Flow checks` banner block entirely (the `validation.errors.length > 0 || validation.warnings.length > 0` div) — its `Fix with Copilot` button moves into the panel (pass the existing `fixWithCopilot` handler).
- Render the panel in the right-dock area alongside drawer/copilot/runs: `{showChecker && (<ResizablePanel storageKey="flow.checkerWidth"><CheckerPanel validation={validation} fixing={fixing} onFixWithCopilot={fixWithCopilot} onClose={() => setShowChecker(false)} onJump={(nodeId) => { setSelectedId(nodeId); document.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }} /></ResizablePanel>)}` (mirror the rail's jump snippet — extract a shared `jumpToNode` callback on the page and use it for BOTH the rail and the checker).

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/checker-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): flow checker panel with click-to-jump and copilot fix"
```

---

### Task 5: Test panel

**Files:**
- Create: `src/components/flows/test-panel.tsx`
- Modify: `src/app/flows/[id]/page.tsx`
- Modify (small): `src/components/flows/test-input-panel.tsx` (export its per-field input renderer OR accept a `layout: 'bar' | 'stack'` prop — pick the smaller change; the panel needs the same schema-driven fields in a vertical stack)

**Interfaces:**
- Consumes: `TriggerInputField[]` (page's `inputFields`), `testInput`/`setTestInput`, `run`/`running`, `statusByNode`, `selectedRun` (latest run detail), `labelForNode`.
- Produces: `TestPanel({ fields, value, onChange, onRun, running, steps, labelForNode, onInspect, onClose })` where `steps: { nodeId: string; status: StepStatus }[]` and `onInspect: () => void` opens the Runs panel.

- [ ] **Step 1: Component**

`test-panel.tsx` (right-dock, run-panel styling):
- Header `Test` + close.
- Body top: the trigger-input form — schema-driven fields stacked vertically (reuse `TestInputPanel`'s field rendering via the chosen refactor) + the raw-payload textarea below a divider; when no fields are declared, just the raw input textarea labeled `Run input`.
- `Run test` primary button (Play icon, `loading={running}`).
- Live results list: one compact row per step of the LATEST run (`steps` prop): status dot (reuse the `STATUS_DOT`-style colors — import `StepStatus` typing from step-card), node label, status text (TypewriterStatus for `running` — import from `@/components/ui/typewriter-status`).
- Footer link `Open full run inspector` → `onInspect`.

- [ ] **Step 2: Page wiring**

- State `showTest`; toolbar `Test` button (FlaskConical icon) toggling it; REMOVE the `build`/`test` mode toggle pill AND the top `TestInputPanel` bar AND the standalone `Test input` toolbar button (the Test panel replaces all three; `mode` state simplifies away — statuses show whenever a run is polling: change `statusByNode={mode === 'test' ? statusByNode : {}}` to just `statusByNode={statusByNode}`; delete `mode` state + its usages).
- `steps` prop = `(selectedRun?.steps ?? []).map((s) => ({ nodeId: s.nodeId, status: s.status }))`.
- `onRun` = existing `run` callback (minus its `setMode` calls — clean those up); `onInspect` = `() => setShowRuns(true)`.
- Keep the toolbar `Run` button working as before (it can stay as the quick-run affordance).

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/test-panel.tsx src/components/flows/test-input-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): first-class Test panel — inputs, run, live step statuses"
```

---

### Task 6: Version history panel + view/restore

**Files:**
- Create: `src/components/flows/versions-panel.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 2's endpoints; `commitGraph`; the canvas render path.
- Produces: `VersionsPanel({ flowId, currentVersion, onView, onRestore, onClose })` — fetches the list itself; `onView(version: number)` and `onRestore(version: number)` are page callbacks. Page adds `viewingVersion: { version: number; graph: FlowGraph } | null` state — while set, the canvas renders `viewingVersion.graph`, ALL mutation callbacks no-op, and a banner shows `Viewing v<N>` + `Restore this version` + `Close`.

- [ ] **Step 1: Component**

`versions-panel.tsx`: fetch `GET /api/flows/${flowId}/versions` on mount; list rows `v<version>` + `publishedAt` date (+ `note` when present) + two small buttons `View` / `Restore` (Restore confirms: `window.confirm('Restore v<N> into the draft? Your current draft is replaced (undo with ⌘Z).')`). Empty state: `Publish the flow to start its version history.` Highlight the row matching `currentVersion` with a `Current` badge.

- [ ] **Step 2: Page wiring**

- State: `showVersions`, `viewingVersion`.
- Toolbar `History` button (History icon) toggling the panel (ResizablePanel `flow.versionsWidth`).
- `onView`: `fetch(…/versions?version=N)` → `setViewingVersion({ version: N, graph: data.version.graph })`.
- `onRestore`: `POST …/versions {version, action:'restore'}` → on success `commitGraph(data.flow.graph)` (undo-able), `setViewingVersion(null)`, toast `Restored v<N> into the draft.`.
- While `viewingVersion`: pass `viewingVersion.graph` to `<FlowCanvas graph={…}>`; gate EVERY mutation prop with the viewing flag (onChangeNode/onInsertAfter/onAppendBranch/onMoveAfter/onReorderContainer/onDeleteNode/onDuplicateNode/onPickTrigger → no-op or hidden); also suppress keyboard delete/paste (guard in the keydown handler) and show a slim banner above the canvas: `Viewing v<N> — read-only` + `Restore this version` + `Close` buttons. The drawer stays closed (`setSelectedId(null)` when entering viewing mode).

- [ ] **Step 3: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add src/components/flows/versions-panel.tsx 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): version history — view snapshots read-only and restore to draft"
```

---

### Task 7: Activity page + runs filters

**Files:**
- Modify: `src/app/api/flows/[id]/runs/route.ts`
- Create: `src/app/flows/[id]/activity/page.tsx`
- Modify (nav): `src/app/flows/[id]/page.tsx` (toolbar `Activity` link)

**Interfaces:**
- Produces: runs GET accepts `?status=a,b`, `?take=N` (default 20, `Math.min(100, …)`), `?summary=1` (steps return only `{ nodeId, status, order, error }` — no input/output payloads); `/flows/<id>/activity` page.

- [ ] **Step 1: Runs route filters**

Parse searchParams; `where: { flowId: id, organizationId, ...(statusList.length ? { status: { in: statusList } } : {}) }`; `take`; when `summary` truthy use the reduced step select and skip `input`/`output`/`error` on runs? (keep run-level `error`; omit run `input`/`output`). Existing no-param behavior byte-identical.

- [ ] **Step 2: Activity page**

`src/app/flows/[id]/activity/page.tsx` (`'use client'`): header `Activity` + flow name (fetch via `/api/flows` list like the builder does) + `Back to builder` link; filter chips `All / Running / Succeeded / Failed / Waiting` mapping to `?status=`; table rows: status Badge, started (locale string), duration (`finishedAt-startedAt`, `—` while running), trigger type (`run.trigger?.type` — note: shape() must include `trigger` — add it in Step 1), error preview (truncated, red). Row click expands per-step rows (status dot + node label by nodeId — fetch once WITHOUT summary for the expanded run, or include steps from the summary fetch since summary still carries nodeId/status/order/error — use the summary steps). `Refresh` button; auto-poll every 5s while any visible run is `running`/`waiting` (clear on unmount).

- [ ] **Step 3: Builder nav**

Toolbar: an `Activity` ghost button (`router.push(`/flows/${id}/activity`)`, ListChecks icon is taken by Runs — use `ScrollText` or `History`-adjacent icon not already used).

- [ ] **Step 4: Verify + commit**

`npm run typecheck && npm run lint && npm test`

```bash
git add 'src/app/api/flows/[id]/runs/route.ts' 'src/app/flows/[id]/activity/page.tsx' 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): activity page with filtered run history"
```

---

### Task 8: Final verification

- [ ] `npm run typecheck && npm run lint && npm test` — all green.
- [ ] Reasoning smoke checklist: publish → FlowVersion row (transactional, version matches); restore → draft replaced (undo works), published untouched; checker jump rings the node; banner gone, badge counts match; Test panel drives runs + live statuses without the old mode toggle; version viewing blocks every mutation incl. keyboard; activity filters hit the API; existing runs-panel polling unaffected.
