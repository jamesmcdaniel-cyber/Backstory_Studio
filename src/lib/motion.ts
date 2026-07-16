/**
 * Shared motion vocabulary for the whole app. Keeping springs, easings, and
 * variants in one place is what makes the platform's motion feel like one
 * system rather than a hundred ad-hoc transitions. Pure data + pure helpers so
 * the math (tilt, clamp) is unit-testable; the React primitives that consume it
 * live in `@/components/ui/motion-primitives`.
 *
 * Reduced motion is already honored globally by `<MotionConfig reducedMotion="user">`
 * (client-providers) for every `motion` component; interactive helpers here also
 * short-circuit under `useReducedMotion()` at their call sites.
 */

import type { Transition, Variants } from 'motion/react'

// Easings mirror the design tokens (tailwind.config: out-quart / spring) so
// JS-driven motion matches CSS-driven motion to the millisecond.
export const EASE = {
  outQuart: [0.25, 1, 0.5, 1] as const,
  spring: [0.34, 1.3, 0.64, 1] as const,
}

// Named spring presets. `soft` for surfaces/reveals, `snappy` for UI feedback,
// `bouncy` for playful accents, `gentle` for large ambient movement.
export const SPRING: Record<'soft' | 'snappy' | 'bouncy' | 'gentle', Transition> = {
  soft: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
  snappy: { type: 'spring', stiffness: 500, damping: 40 },
  bouncy: { type: 'spring', stiffness: 400, damping: 17 },
  gentle: { type: 'spring', stiffness: 120, damping: 24, mass: 1.1 },
}

/** Fade + rise — the platform's default entrance (matches CSS `fade-in-up`). */
export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE.outQuart } },
}

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE.outQuart } },
}

/** Scale + fade — for elements that pop into place (dialogs, popovers, tiles). */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  show: { opacity: 1, scale: 1, transition: SPRING.soft },
}

/** Container whose children reveal in sequence. Pair with an item variant. */
export function staggerContainer(stagger = 0.06, delayChildren = 0): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren } },
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export type TiltRect = { left: number; top: number; width: number; height: number }
export type Tilt = { rotateX: number; rotateY: number; glareX: number; glareY: number }

/**
 * 3D card tilt from a pointer position. Given the pointer's client coords and
 * the element's bounding rect, returns rotation (degrees) plus the specular
 * glare's center as a 0–100% position. The card leans TOWARD the cursor:
 * pointer above center tips the top back (negative rotateX), pointer right of
 * center swings the right edge forward (positive rotateY). Pure so it's tested
 * without a DOM.
 */
export function tiltFromPointer(clientX: number, clientY: number, rect: TiltRect, maxDeg = 8): Tilt {
  // Guard a zero-size rect (unmeasured element) — no tilt, centered glare.
  if (rect.width <= 0 || rect.height <= 0) return { rotateX: 0, rotateY: 0, glareX: 50, glareY: 50 }
  // Normalized position within the card, -0.5 (left/top) … 0.5 (right/bottom).
  const nx = clamp((clientX - rect.left) / rect.width, 0, 1) - 0.5
  const ny = clamp((clientY - rect.top) / rect.height, 0, 1) - 0.5
  // `+ 0` collapses -0 → +0 so a centered pointer returns a clean flat tilt.
  return {
    rotateY: nx * maxDeg * 2 + 0,
    rotateX: -ny * maxDeg * 2 + 0,
    glareX: (nx + 0.5) * 100,
    glareY: (ny + 0.5) * 100,
  }
}

export const TILT_REST: Tilt = { rotateX: 0, rotateY: 0, glareX: 50, glareY: 50 }
