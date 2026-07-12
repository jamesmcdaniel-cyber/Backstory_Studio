# WS12-D: Auto-Template Onboarding UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sub-project D (`docs/superpowers/specs/2026-07-11-auto-template-generation-roadmap-design.md` §D): the pictured 3-step onboarding — **Connect your tools → Your data takes shape → Your AI goes live** — with the proposal review inbox as the middle step. Depends on B (`GET /api/integrations/count`), C (`GET /api/template-proposals` + accept/dismiss + generation trigger), A (the prioritized catalogue read).

**Architecture:** Extend `/connect` (today a 2-step entitlement+MCP gate) into a 3-stage stepper. Stage 1 shows connected-integration progress toward the 3-gate. Stage 2 shows learning progress + the proposal review inbox (accept/edit/dismiss). Stage 3 deploys from the org's own-first catalogue. Generation is triggered when the 3rd integration connects; the inbox polls for proposals as they land.

**Tech Stack:** Next.js/React client, Tailwind, the existing jsdom/@testing-library harness (verify it exists — the design doc references it) for the inbox + gate-meter.

## Global Constraints

- Style: single quotes, NO semicolons, 2-space indent. Gate: `npm run typecheck && npm run lint && npm test` — capture baseline, report exact. NEVER run dev/build/prisma.
- No raw `{{token}}`/enum strings user-visible; plain-English copy. Match the app's existing onboarding/connect visual conventions (read `src/app/connect/page.tsx` + `src/components/layout/setup-gate.tsx`).
- Do NOT regress the existing 2-step entitlement gate (People.ai + Backstory MCP) — the 3-step flow WRAPS/extends it, it must still enforce entitlement before the app opens.

---

### Task 1: 3-step stepper shell + gate meter

**Files:** `src/app/connect/page.tsx` (restructure into 3 stages), read `src/app/api/setup/status/route.ts` + `src/components/layout/setup-gate.tsx`, consume `GET /api/integrations/count`.

**Design:** a 3-stage stepper: **Connect your tools** (stage 1) — the existing entitlement/MCP connect surface PLUS a connected-integration progress meter "N of 3 tools connected" fed by `/api/integrations/count` (`connected`/`required`/`meetsGate`); advancing to stage 2 requires `meetsGate` (3+). **Your data takes shape** (stage 2 — Task 2). **Your AI goes live** (stage 3 — Task 3). Preserve entitlement enforcement. Copy exact: the three stage titles as written.

**Steps:**
- [ ] Restructure `/connect` into the stepper; keep entitlement gating intact; wire stage 1's meter to `/api/integrations/count`.
- [ ] Pure `gateMeter(connected, required)` helper (progress %, label, meetsGate) + unit test.
- [ ] Gate + commit `feat(onboarding): three-step connect flow with a 3-integration progress meter`

---

### Task 2: "Your data takes shape" — proposal review inbox

**Files:** `src/components/onboarding/proposal-inbox.tsx` (new) + the connect page stage 2, consume `GET /api/template-proposals` + accept/dismiss.

**Design:** stage 2 shows learning progress ("Analyzing how your team uses <providers>…") and the review inbox: each open `TemplateProposal` as a card — title, rationale (why it was proposed, grounded in usage), kind badge (New agent / New flow / Improve <existing>), and Accept / Dismiss. Accept a template-kind → POST accept → card removed + toast "Added to your catalogue"; accept a `process_improvement` → open the target flow/agent editor (the accept response returns `{targetType,targetId}`) in a new tab; dismiss → POST dismiss → card removed. Poll `/api/template-proposals` every ~5s while generation may still be running (stop after it settles / on unmount). Empty state before generation: "Your AI is still learning — this updates as it finds patterns." Empty after: "No suggestions right now — you can build your own anytime."

**Steps:**
- [ ] Inbox component + stage 2 wiring; accept/dismiss with optimistic removal + honest toasts; process-improvement opens the editor.
- [ ] Poll-until-settled with cleanup on unmount.
- [ ] Component tests (if the jsdom/@testing-library harness exists — verify): render proposals, accept → removed, dismiss → removed, process-improvement accept → navigates; else a pure test for the list-reducer/poll-stop logic + note the UI gap.
- [ ] Gate + commit `feat(onboarding): proposal review inbox — accept or dismiss AI template suggestions`

---

### Task 3: "Your AI goes live" + generation trigger + finalize

**Files:** connect page stage 3, the gate-first-clears generation enqueue (C's `dispatchTemplateGeneration`), read A's catalogue read.

**Design:** stage 3 lists the org's now-prioritized catalogue (own AI-generated first, then own, then global) with deploy actions (Use template → agent; Deploy as Flow where applicable) — reuse the existing templates page components/read. When the 3rd integration connects (stage 1 → meetsGate flips true), fire C's generation enqueue once (debounced) so proposals are landing by the time the user reaches stage 2.

**Steps:**
- [ ] Stage 3 catalogue deploy (reuse templates surface, own-first ordering already from A).
- [ ] Trigger generation on gate-clear (idempotent/debounced — don't double-enqueue).
- [ ] Full local gate; whole-sub-project review (emphasis: entitlement gate not regressed; no cross-org proposal/template exposure in the UI; poll cleanup; accept/dismiss race with C's idempotent API). Fix Critical/Important.
- [ ] CI-mode gate on a session-unique DB + build; commit `feat(onboarding): deploy from your prioritized catalogue when your AI goes live`; push; confirm CI green.
