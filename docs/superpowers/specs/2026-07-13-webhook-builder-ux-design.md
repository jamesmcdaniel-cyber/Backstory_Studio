# Webhook Builder UX — Complete Trigger Setup in the Flow Builder

**Date:** 2026-07-13
**Status:** Approved (scope + design confirmed by James)
**Scope decision:** "Complete builder UX" — full trigger-type parity in the expanded card, read-only webhook status, arming clarity. Explicitly OUT of scope (offered, not chosen): sample-payload capture / auto-derived input fields, delivery history, query-param auth alternatives.

## Problem

Webhook triggers work end-to-end at the API layer (`POST /api/flows/[id]/trigger` authenticates via per-flow secret hash, rate-limits, applies the trigger condition, runs the published graph) and the **drawer** has a full webhook editor. But the builder cannot "fully set up" a webhook because:

1. **The expanded card's trigger editor is manual-only.** `TriggerBody` (`src/components/flows/step-card.tsx` ~line 782) has no trigger-type picker, and every input-field mutation hardcodes `type: 'manual'` — editing a field on a webhook-triggered flow **silently reverts the trigger to manual**.
2. **The drawer shows nothing for an existing webhook until you click "Get webhook URL"**, which POSTs to `trigger-secret` — a mutation (its non-rotate branch even force-writes `trigger.type`) just to *display* state.
3. **Arming is implicit.** Webhook calls only run the published graph, but the builder never says whether the webhook is armed.

## Design

### 1. Shared `TriggerEditor` component

New file `src/components/flows/trigger-editor.tsx`, exporting `TriggerEditor` — the trigger-type picker plus the per-type panels (schedule, signal, webhook) and the "only run when…" condition rows, lifted from `step-drawer.tsx`'s `TriggerEditor` (~lines 1483–1720+). Presentational deltas between card and drawer (field/label class names) are parameterized via a small `classes` prop with the drawer's values as defaults — no behavioral forks.

- **Drawer:** replaces its inline `TriggerEditor` with the shared one (net deletion from the ~1800-line `step-drawer.tsx`).
- **Card:** `TriggerBody` renders the shared editor above its existing icon-grid input-fields UI.
- **Input fields stay outside** the shared component: the drawer keeps `InputFieldsEditor`, the card keeps its icon-grid rows (including the Default column added in WS11). They already edit the same `trigger.inputFields` shape.
- The chip-editor condition rows and their token-insert handles move with the component (they are self-contained: local refs + `buildDataTree({ upstream: [], inputFields, context: false })`).

### 2. Card no longer reverts the trigger type

Every `TriggerBody` mutation that currently writes `type: 'manual'` (`addField`, `updateField`, `removeField`) preserves `trigger.type` instead. Adding input fields to a webhook/schedule/signal trigger is legal — fields describe the expected payload for every type.

### 3. Read-only webhook status: `GET /api/flows/[id]/trigger-secret`

Returns `{ success, hasSecret: boolean, url: string }` — **never** the secret (plaintext exists only at mint/rotate time; only the hash is stored). Auth/scoping identical to the sibling POST: `withAuthenticatedApi`, org-scoped `flow.findFirst` with `agentVisibilityScope`, 404 on missing/cross-org.

- The webhook panel fetches this on mount and on switching type to webhook, so an already-configured webhook immediately shows: the URL (copyable), "Secret is set — rotate to mint a new one" (or the mint button when `hasSecret` is false), the example JSON body, and the curl snippet with `<secret>` placeholder.
- "Get webhook URL" (mint) and rotate keep using POST and keep the show-once secret semantics.
- **POST cleanup:** the non-rotate short-circuit's side-effect write of `trigger: { ...trigger, type: 'webhook' }` is removed — display goes through GET now, and the trigger type is owned by the graph node via save/publish (`triggerFromGraph` + `preserveWebhookSecretHash` in `src/app/api/flows/route.ts` and `[id]/publish/route.ts`). Mint/rotate continue to write `webhookSecretHash` (merged into the existing trigger JSON) and may keep setting `type: 'webhook'` on the actual mint, since minting is only reachable from the webhook editor.
- Route-smoke completeness guard: the new GET handler needs a smoke case (`src/app/api/__tests__/route-smoke.test.ts`) or CI fails by design.

### 4. Arming clarity

- Webhook panel footer: when the flow has no published version, show "Webhook calls run the **published** version — publish this flow to arm the webhook." (mirrors the schedule panel's existing copy); when published, "Armed — calls to this URL start a run."
- The canvas trigger card subtitle for webhook triggers appends "· publish to arm" when unpublished. The builder page already holds publish state; thread it (or the boolean) to where `subtitleFor` composes trigger text in `flow-canvas.tsx`.
- No new data is fetched for this — publish state is already client-side.

### 5. Error handling

- GET failures in the panel degrade to the current pre-fetch behavior (mint button + no status line), with a toast only on explicit user action failures (mint/rotate/copy), matching existing toasts.
- `NEXT_PUBLIC_APP_URL` unset (local dev) yields a relative URL exactly as POST does today — unchanged.

### 6. Testing

- **Component (jsdom harness, `src/components/flows/__tests__/`):** card shows the type picker; selecting webhook writes `type: 'webhook'` through `onChange`; REGRESSION: `updateField` on a webhook trigger preserves the type; shared editor renders in both card and drawer contexts (drawer coverage may ride the existing drawer tests).
- **Route (DB-gated, CI-mode):** GET returns `hasSecret: false` + url for a secretless flow, `hasSecret: true` after mint, never a `secret` field, 404 for cross-org; smoke case for the completeness guard.
- **Fetch-in-jsdom:** the webhook panel's status fetch is injected/mocked per the harness's existing pattern for components that fetch (`mintWebhook` already fetches — follow whatever the harness does for it; if drawer tests currently avoid mounting the webhook panel, gate the auto-fetch behind a prop default that tests can stub).

## Non-goals

Payload capture / "listen for test request", delivery history, alternative auth schemes, outbound-webhook steps (the `http` step covers calling out), agent trigger-secret parity changes.
