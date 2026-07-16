'use client'

import { Aurora } from '@/components/ui/motion-primitives'

/**
 * Landing-hero centerpiece. Renders the ambient CSS aurora — the brand horizon
 * as a glowing atmosphere the product shot floats in front of.
 *
 * NOTE: the WebGL centerpiece (`horizon-scene`) is temporarily out of the mount
 * path. `@react-three/fiber@8` bundles `react-reconciler@0.27`, which reads
 * `ReactCurrentBatchConfig` off React's internals — a field this project's React
 * 18.3.1 no longer exposes there, so the reconciler threw on the client and
 * white-screened the landing page. Re-introduced separately as a vanilla three.js
 * scene (no react-reconciler) so it can't hit that mismatch.
 */
export function HorizonHero({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <Aurora intensity={1.1} />
    </div>
  )
}
