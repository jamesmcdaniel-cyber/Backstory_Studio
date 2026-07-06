# UI Modernization — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming session with James)

## Problem

The platform's UI stack is already correct — Tailwind 3.4, Radix primitives, CVA/clsx/tailwind-merge (shadcn pattern), lucide-react, sonner — and the Backstory brand token layer (Horizon/Graphite, KMR Waldenburg + Anonymous Pro, deep-blue shadows) was integrated on 2026-06-30. Yet the app reads as static, templated, and under-polished. Diagnosis: the expressive layers on top of the tokens were never built — zero custom keyframes in `tailwind.config.js`, only stock Radix fades, white-on-white surfaces, no skeletons/empty states, no interaction depth.

## Decisions (from brainstorming)

- **Approach:** pure layered pass — foundation → primitives → screens. No mockup detours.
- **Layout freeze (added after review):** every page keeps its current layout and information architecture exactly as-is. The elevation is component- and widget-level only — swapping raw elements for enhanced primitives, adding states and motion. No moving, regrouping, or restructuring of page content.
- **Scope:** everything — logged-in app, auth/onboarding, landing page — in one systematic pass.
- **Brand:** strictly within the existing design guide. No new brand values; only compositions of existing tokens. Calm declarative voice, sentence case, no emoji.
- **New dependencies:** `motion` (Framer Motion successor) and `cmdk` (command palette). Nothing else.
- **Page background:** shifts from white to graphite-50 so white surfaces read as elevated (approved explicitly).
- **⌘K command palette:** in scope.
- **Out of scope:** dark mode (config supports it; separate project), Tailwind 3→4 upgrade, component-library swaps.

## Layer 1 — Foundation

Lives in `tailwind.config.js` + `src/app/backstory-design.css`. No component changes.

**Motion vocabulary** (single palette, never improvised per-file):
- Keyframes: `fade-in-up` (entrances), `scale-in` (popovers/dialogs), `shimmer` (skeletons), `slide-in-from-right` (panels)
- Durations: `fast` 120ms (hover feedback), `base` 200ms (transitions), `slow` 320ms (page entrances)
- Easings: `ease-out-quart` for entrances; gentle spring-like cubic-bezier for interactive elements
- CSS stagger utility driven by `--stagger-index` so lists/grids cascade in
- Global `prefers-reduced-motion` guard disabling all of it

**`motion` library** only for what CSS cannot do: orchestrated page entrances, layout animations (tab indicator, list reorders), animated dashboard numbers.

**Depth & interaction recipes:**
- Interactive-card hover: `shadow-1 → shadow-2` + 1px lift
- One consistent `focus-visible` ring (horizon-500) across every focusable element

**Surface hierarchy:**
- `--bg-page` → graphite-50 (surfaces stay white and now read as raised)
- `--gradient-horizon-soft` / `--gradient-card-blue` reserved for hero and featured areas
- Metrics/data: `font-mono` + `tabular-nums`

## Layer 2 — Primitives (`src/components/ui/`)

**Upgrades to the existing 12:**
| Component | Change |
|---|---|
| button | loading state w/ spinner, `active:scale-[0.98]`, icon slots, new focus ring |
| input/textarea/select | unified focus treatment, designed error state (border + message), horizon selection |
| card | variants: `flat` / `raised` (default, shadow-1) / `interactive` (hover lift) |
| dialog | brand motion tokens for enter/exit, backdrop blur |
| tabs | animated sliding indicator (`motion` layout animation) |
| badge | mapped to existing `--status-good/warn/risk/info` fills |
| sonner toasts | styled to brand |

**New primitives:**
- `skeleton` — shimmer placeholders (highest-impact single addition)
- `empty-state` — icon + calm declarative headline + one CTA
- `tooltip`, `dropdown-menu` — missing Radix primitives
- `table` — designed data table: row hover, mono numerics, sticky header
- `stat-tile` — dashboard metric card, animated number, mono type
- `page-header` — standardized eyebrow + h1 + description + actions; adopted only where a page already has a header block, in the same position (layout freeze)
- `command palette` — ⌘K via `cmdk`, navigation + quick actions

## Layer 3 — In-place application (screen by screen, layout frozen)

Each screen keeps its exact current layout. The pass swaps raw/plain elements for the enhanced primitives and adds the missing states and motion — nothing moves.

Order (one commit per screen; app shippable throughout):
1. **App shell** — existing sidebar/nav gets polished active/hover states and entrance motion in place; ⌘K wired (an overlay, so no layout impact)
2. **Dashboard** — existing widgets become StatTiles/Cards in their current positions; skeletons on every async region; designed empty states where blanks appear today
3. **Signals** — existing lists/tables re-rendered through the new Table primitive; status badges on brand fills; row hover
4. **Templates** — existing card grid keeps its grid; cards gain the interactive hover-lift variant and designed empty state
5. **Connections / Integrations** — existing cards gain `--status-*` fills; existing dialogs gain brand motion + polish
6. **Auth + Connect (first-run)** — current structure, upgraded inputs/buttons/focus states, `gradient-horizon-soft` background treatment
7. **Landing** — current sections and order preserved; type, buttons, gradients, and spacing polish applied within them

**Per-screen method:** component swap (raw element → enhanced primitive, same position) → states pass (every async region gets loading skeleton + empty + error) → motion pass (entrance stagger, hover feedback). No layout restructuring at any step.

## Guardrails & verification

- All motion behind `prefers-reduced-motion`
- No dark-mode work; no deps beyond `motion` + `cmdk`
- `npm run check` (typecheck + lint + build) passes at every commit
- Visual verification by running the app after each screen
- Do NOT revert the intentional `gray|slate|zinc|neutral → graphite` and `blue|indigo|sky → horizon` remaps in `tailwind.config.js`
