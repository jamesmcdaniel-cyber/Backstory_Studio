# Webhook Builder UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spec `docs/superpowers/specs/2026-07-13-webhook-builder-ux-design.md` — full trigger setup in the flow builder: shared TriggerEditor in card AND drawer (all four trigger types), card stops silently reverting webhook→manual, read-only webhook status endpoint, publish-to-arm clarity.

**Architecture:** Extract the drawer's `TriggerEditor` (step-drawer.tsx:1484–1819) into a shared component; both surfaces render it. New `GET /api/flows/[id]/trigger-secret` returns `{ hasSecret, url }` (never the secret) so the panel shows existing state without mutating. Trigger type remains owned by the graph node (`triggerFromGraph` on save/publish).

**Tech Stack:** Next.js 15 app router, React 18, node:test + jsdom/@testing-library (`.test.tsx` under `__tests__/`), DB-gated route tests via the test-auth seam (CI-mode only).

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Capture the live test baseline before each task (concurrent sessions move it; last seen 817 pass / 2 skip CI-mode, warnings-only lint).
- NO raw `{{`/`}}` or enum strings user-visible.
- Route files may export ONLY HTTP handlers + route config (Next 15 contract — a value export fails the build; see `oauth-authcode.ts` precedent 2026-07-13).
- The route-smoke completeness guard FAILS CI on any `withAuthenticatedApi` GET route without a case in `src/app/api/__tests__/route-smoke.test.ts`.
- Never return the webhook secret from GET; plaintext exists only in the POST mint/rotate response.
- CI-mode gate on a SESSION-UNIQUE DB before push (memory `ci-github-actions-gate`): fresh worktree needs explicit `npx prisma generate` after `npm ci`.
- The working tree may hold a CONCURRENT session's uncommitted WIP (templates domain). `git add <specific files>` only; never `-A`/`-a`/amend/rebase/reset.

**Interfaces produced (used across tasks):**
- `TriggerEditor` props (Task 2, consumed by Task 3): `{ flowId: string, trigger: TriggerData, onChange: (t: TriggerData) => void, published?: boolean, classes?: Partial<TriggerEditorClasses>, children?: ReactNode }` where `TriggerEditorClasses = { field: string, label: string, smallField: string }` (defaults = drawer values). `children` renders directly after the type picker (the drawer puts `InputFieldsEditor` there).
- `TriggerData` moves to `trigger-editor.tsx` and is re-exported from both step-card.tsx and step-drawer.tsx to avoid import churn.
- GET response (Task 1, consumed by Task 2): `{ success: true, hasSecret: boolean, url: string }`.

---

### Task 1: Read-only webhook status endpoint + POST cleanup (TDD)

**Files:**
- Modify: `src/app/api/flows/[id]/trigger-secret/route.ts`
- Test: `src/app/api/flows/__tests__/trigger-secret.db.test.ts` (create)
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (completeness guard case)

- [ ] **Step 1: Write the failing DB-gated test.** Mirror `src/app/api/template-proposals/__tests__/routes.db.test.ts`'s structure exactly (TEST_DATABASE_URL gate, `before` dynamic imports, `seedTestOrg`/`installTestAuth`, org cleanup in `finally`):

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let route: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    route = await import('../[id]/trigger-secret/route')
  })

  const get = (flowId: string) =>
    route.GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/trigger-secret`)))
  const mint = (flowId: string) =>
    route.POST(new NextRequest(new URL(`http://test/api/flows/${flowId}/trigger-secret`), { method: 'POST', body: JSON.stringify({}) }))
  const mkFlow = (organizationId: string, userId: string) =>
    prisma.flow.create({ data: { organizationId, userId, name: 'Webhook flow', graph: { nodes: [], edges: [] }, status: 'ACTIVE' } })

  test('GET reports hasSecret=false and the trigger URL for a secretless flow', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const res = await get(flow.id)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.hasSecret, false)
      assert.ok(body.url.endsWith(`/api/flows/${flow.id}/trigger`))
      assert.ok(!('secret' in body), 'GET must never carry a secret field')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('GET reports hasSecret=true after mint, still without a secret; POST no longer rewrites trigger.type on re-query', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      assert.equal((await mint(flow.id)).status, 200)
      const res = await get(flow.id)
      const body = await res.json()
      assert.equal(body.hasSecret, true)
      assert.ok(!('secret' in body))
      // Re-query mint path (hasSecret && !rotate) must not write the row:
      // wipe type, call POST non-rotate, type stays absent (save/publish own it).
      const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      const { type: _drop, ...rest } = row.trigger as Record<string, unknown>
      await prisma.flow.update({ where: { id: flow.id, organizationId: s.organizationId }, data: { trigger: rest } })
      await mint(flow.id)
      const after = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      assert.equal((after.trigger as Record<string, unknown>).type, undefined, 'non-rotate POST is read-only on the row')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('cross-org GET → 404', async () => {
    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    try {
      installTestAuth(owner.auth)
      const flow = await mkFlow(owner.organizationId, owner.userId)
      installTestAuth(other.auth)
      assert.equal((await get(flow.id)).status, 404)
    } finally {
      await owner.cleanup(); await other.cleanup()
      await prisma.organization.delete({ where: { id: owner.organizationId } }).catch(() => {})
      await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => {})
    }
  })
}
```

Check `test-auth.ts`'s actual seed return shape (`organizationId`/`userId`/`auth`/`cleanup`) and the sibling test's Flow create fields before running; adjust ONLY to match reality, not the assertions. If `seedTestOrg` exposes different names, mirror the sibling test verbatim.

- [ ] **Step 2: Run to verify failure.** `TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/<session-db> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/flows/__tests__/trigger-secret.db.test.ts` (create the DB + `npx prisma migrate deploy` first). Expected: FAIL — `route.GET is not a function`.

- [ ] **Step 3: Implement.** In `trigger-secret/route.ts`, add GET and clean POST:

```ts
// Read-only status for the builder: does a secret exist, and what is the URL.
// NEVER returns the secret — plaintext exists only in the POST mint/rotate response.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return {
    success: true,
    hasSecret: typeof trigger.webhookSecretHash === 'string',
    url: `${baseUrl}/api/flows/${flow.id}/trigger`,
  }
})
```

In POST, the `hasSecret && !rotate` branch becomes a pure read (delete the `prisma.flow.update(...).catch(() => undefined)` side-effect write):

```ts
  if (hasSecret && !rotate) {
    return { ...base, hasSecret: true, secret: null }
  }
```

The mint branch is unchanged (it still writes `type: 'webhook'` + `webhookSecretHash` — minting is only reachable from the webhook editor, where that type is what the user chose).

- [ ] **Step 4: Add the route-smoke case.** Open `src/app/api/__tests__/route-smoke.test.ts`, find how existing `[id]` GET routes are enumerated/asserted (<500 with a seeded or dummy id), and add `/api/flows/[id]/trigger-secret` following that exact pattern. Run the smoke suite with TEST_DATABASE_URL to prove the completeness guard passes.

- [ ] **Step 5: Verify + commit.** Targeted tests green, `npx tsc --noEmit` clean. `git add src/app/api/flows/[id]/trigger-secret/route.ts src/app/api/flows/__tests__/trigger-secret.db.test.ts src/app/api/__tests__/route-smoke.test.ts && git commit -m "feat(flows): read-only webhook status endpoint — GET trigger-secret"`

---

### Task 2: Extract shared TriggerEditor + webhook status panel (TDD)

**Files:**
- Create: `src/components/flows/trigger-editor.tsx`
- Modify: `src/components/flows/step-drawer.tsx` (delete inline TriggerEditor 1484–1819, render shared one; keep `InputFieldsEditor` and pass it as `children`)
- Test: `src/components/flows/__tests__/trigger-editor.test.tsx` (create)

**Interfaces:**
- Produces: `TriggerEditor` + `TriggerData` + `TriggerEditorClasses` as specified in Global Constraints. Webhook state shape inside the component: `{ url: string, secret: string | null, hasSecret: boolean }`.

- [ ] **Step 1: Write failing tests** (jsdom harness; mirror an existing `.test.tsx` for renderer setup). Stub `globalThis.fetch` — there is no fetch-mock precedent in this suite, so keep it primitive and restore in `finally`:

```tsx
test('webhook panel auto-loads existing status: URL shown, secret-is-set state, no mint needed', async () => {
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ success: true, hasSecret: true, url: 'https://app.example/api/flows/f1/trigger' }) }
  }) as any
  try {
    render(<TriggerEditor flowId='f1' trigger={{ type: 'webhook' }} onChange={() => {}} published />)
    await screen.findByText('https://app.example/api/flows/f1/trigger')
    assert.ok(calls.some((u) => u.includes('/api/flows/f1/trigger-secret')))
    assert.ok(screen.getByText(/secret already exists|Secret is set/i))
    assert.ok(screen.getByText(/Armed — calls to this URL start a run/i))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('unpublished webhook flow shows publish-to-arm guidance', async () => { /* same stub, published={false}; assert /publish this flow to arm/i */ })

test('type picker writes through onChange', () => {
  const seen: any[] = []
  render(<TriggerEditor flowId='f1' trigger={{ type: 'manual' }} onChange={(t) => seen.push(t)} />)
  fireEvent.change(screen.getByLabelText(/trigger type/i) ?? screen.getByDisplayValue('Manual / on run'), { target: { value: 'webhook' } })
  assert.equal(seen.at(-1)?.type, 'webhook')
})
```

(Adjust query idioms to the harness's conventions — the assertions are the contract. Give the type select an accessible name via its existing label if `getByLabelText` needs it.)

- [ ] **Step 2: Run to verify failure** (module doesn't exist). `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/trigger-editor.test.tsx` → FAIL.

- [ ] **Step 3: Create `trigger-editor.tsx`.** Move step-drawer.tsx's `TriggerEditor` (1484–1819) and the `TriggerData` type wholesale. Changes during the move — nothing else:
  1. Props gain `published?: boolean`, `classes?: Partial<TriggerEditorClasses>`, `children?: ReactNode`. Resolve `const { field, label, smallField } = { field: fieldClass, label: labelClass, smallField: smallFieldDefault, ...classes }` where the defaults are the CURRENT drawer class strings (copy them in as local constants — do not import from step-drawer).
  2. Render `{children}` immediately after the type-picker `<div>` (this is where the drawer's `InputFieldsEditor` sat).
  3. Webhook status auto-fetch: `useEffect(() => { if (type !== 'webhook') return; let alive = true; fetch(`/api/flows/${flowId}/trigger-secret`).then(r => r.ok ? r.json() : null).then(d => { if (alive && d?.success) setWebhook({ url: d.url, secret: null, hasSecret: d.hasSecret }) }).catch(() => {}); return () => { alive = false } }, [type, flowId])`. Extend the webhook state type with `hasSecret: boolean` (mint sets `hasSecret: true`). Panel rendering: when `webhook && !webhook.hasSecret`, the primary button reads "Create webhook secret" (mint); when `hasSecret`, show URL/header/example blocks as today with the existing "A secret already exists. Rotate to mint and display a new one." line when `secret === null`.
  4. Arming line at the panel footer, replacing the current static sentence: `published === false` → `Webhook calls run the published version — publish this flow to arm the webhook.`; `published` truthy → `Armed — calls to this URL start a run.`; `published === undefined` → keep the current neutral sentence (surfaces that don't know).
  5. Imports it needs (verify each resolves): `TokenTextEditor` + `TokenTextEditorHandle`, `DataTree`, `buildDataTree`, `clausesOf`, `CONDITION_OPS`, `CONDITION_OP_LABELS`, `ConditionOp`/`ConditionClause` types, `TRIGGER_LABEL_CTX` (check where it lives — if it's local to step-drawer, move it here and re-export), `nextOccurrence` + `AgentSchedule`, `KNOWN_SIGNALS`, `FREQUENCIES` (move if drawer-local), `toast`, `Button`, lucide icons (`Link2`, `RefreshCw`, `Copy`, `Plus`, `Trash2`).

- [ ] **Step 4: Swap the drawer.** In step-drawer.tsx delete the moved code, `import { TriggerEditor, type TriggerData } from './trigger-editor'`, and update the render site (~line 400):

```tsx
<TriggerEditor
  flowId={flowId}
  trigger={(node.data.trigger as TriggerData | undefined) ?? { type: 'manual' }}
  onChange={(trigger) => onChange({ ...node, data: { trigger } })}
  published={published}
>
  <InputFieldsEditor
    fields={trigger.inputFields ?? []}
    onChange={(inputFields) => onChange({ ...node, data: { trigger: { ...trigger, inputFields: inputFields.length ? inputFields : undefined } } })}
  />
</TriggerEditor>
```

Thread `published?: boolean` into StepDrawer's props and from the page (`src/app/flows/[id]/page.tsx` has `published` state at line 173; find the `<StepDrawer` render and pass it).

- [ ] **Step 5: Run all flows component tests + typecheck.** Existing drawer tests must stay green (the drawer's DOM for triggers is unchanged apart from the arming line). Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/components/flows/trigger-editor.tsx src/components/flows/step-drawer.tsx src/components/flows/__tests__/trigger-editor.test.tsx src/app/flows/[id]/page.tsx && git commit -m "feat(flows): shared TriggerEditor — webhook status auto-loads, publish-to-arm copy"`

---

### Task 3: Card adopts the shared editor + stops reverting the trigger type (TDD)

**Files:**
- Modify: `src/components/flows/step-card.tsx` (TriggerBody ~782–880; props)
- Modify: `src/components/flows/flow-canvas.tsx` (thread `flowId`/`published`; webhook subtitle)
- Modify: `src/app/flows/[id]/page.tsx` (pass `flowId={id}` + `published` to `<FlowCanvas` at ~line 991)
- Test: `src/components/flows/__tests__/trigger-body-type.test.tsx` (create)

**Interfaces:**
- Consumes: `TriggerEditor`/`TriggerData` from Task 2.

- [ ] **Step 1: Write failing tests** (reuse `trigger-body-default.test.tsx`'s StepCard render harness):

```tsx
test('REGRESSION: editing an input field on a webhook trigger preserves type webhook', () => {
  // node.data.trigger = { type: 'webhook', inputFields: [{ name: 'account', type: 'string' }] }
  // fire a change on the field-name input; assert onChange payload trigger.type === 'webhook'
})
test('card trigger editor offers the type picker and switching to webhook writes type webhook', () => {})
test('card webhook panel renders (URL block present) with stubbed fetch', async () => {})
```

Write them out fully in the style of Task 2's tests; the regression test is the load-bearing one — it must fail against current code (which writes `type: 'manual'`).

- [ ] **Step 2: Run to verify the regression test fails** against current TriggerBody. Expected: FAIL with `trigger.type === 'manual'`.

- [ ] **Step 3: Fix TriggerBody + integrate.**
  1. In `addField`/`updateField`/`removeField`, replace `{ ...trigger, type: 'manual', inputFields: ... }` with `{ ...trigger, inputFields: ... }` (type preserved; `type ?? 'manual'` remains the display default).
  2. Render the shared editor at the top of TriggerBody's returned JSX: `<TriggerEditor flowId={flowId} trigger={trigger} onChange={(next) => setTriggerRaw(next)} published={published} classes={{ field: controlClass, label: cardLabelClass, smallField: cardSmallFieldClass }} />` where `setTriggerRaw(next)` is `update({ ...node, data: { ...node.data, trigger: next } })`. Pick the card's actual existing class constants; if a card equivalent doesn't exist, use the drawer defaults (omit the key).
  3. The card's icon-grid input-fields UI stays below, unchanged (it and the shared editor both write `trigger.inputFields`; the shared editor gets NO children in the card so fields aren't rendered twice).
  4. Thread props: `TriggerBody({ node, update, flowId, published })`; StepCard props gain `flowId?: string; published?: boolean` (optional with safe default — StepCard has other consumers; `flowId` undefined hides nothing except the status fetch will 404 silently, so guard: only render TriggerEditor's webhook auto-fetch when flowId is truthy — simplest is `flowId ?? ''` + skip fetch on empty string inside the component: add `if (!flowId) return` first line of the effect).
  5. FlowCanvas props gain `flowId?: string; published?: boolean`; pass both to every `<StepCard`. Page passes `flowId={id}` and `published={published}`.
  6. Webhook subtitle in `subtitleFor` (flow-canvas.tsx ~247): after the signal case, add `if (type === 'webhook') return published === false ? `${inputLine} · publish to arm` : inputLine` (webhook/manual currently share the fallthrough; manual keeps it).

- [ ] **Step 4: Run the new tests + all flows component tests + typecheck.** Expected: PASS, no drawer/card regressions.

- [ ] **Step 5: Commit.** `git add src/components/flows/step-card.tsx src/components/flows/flow-canvas.tsx src/app/flows/[id]/page.tsx src/components/flows/__tests__/trigger-body-type.test.tsx && git commit -m "feat(flows): full trigger setup in the card — type picker, webhook panel, no more silent manual revert"`

---

### Task 4: Final verification + review + push

- [ ] Full local gate (typecheck, lint, `npm test`).
- [ ] Whole-feature review (emphasis: no drawer behavior drift from the extraction — diff the moved JSX against the deleted block; secret never in GET response or component state after auto-fetch; card/drawer both write the same `TriggerData` shape; the POST non-rotate branch is genuinely read-only now; route-smoke completeness guard passes). Fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB (explicit `npx prisma generate` in fresh worktree) + `npm run build`; push; confirm GitHub Actions green.
