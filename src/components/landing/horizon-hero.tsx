'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { Aurora } from '@/components/ui/motion-primitives'

/**
 * Landing-hero centerpiece. The WebGL scene is heavy, so it's code-split
 * (ssr:false) and only mounted after paint, on capable clients that allow
 * motion. Everyone else — reduced-motion users, SSR, the split-second before
 * the bundle lands — gets the CSS aurora, which is the same visual language at
 * a fraction of the cost. Drop this into a `relative` hero container as a
 * background layer.
 *
 * The scene is VANILLA three.js (see horizon-scene): no react-reconciler, so it
 * can't recreate the React-internals crash that @react-three/fiber caused.
 */

const HorizonScene = dynamic(() => import('./horizon-scene'), {
  ssr: false,
  loading: () => <Aurora intensity={1.1} />,
})

export function HorizonHero({ className }: { className?: string }) {
  const reduced = useReducedMotion()
  const [mounted, setMounted] = useState(false)
  // Defer to after first paint so the marketing copy is interactive instantly
  // and the 3D bundle never blocks it.
  useEffect(() => setMounted(true), [])

  const show3d = mounted && !reduced

  return (
    <div className={className} aria-hidden="true">
      {/* Aurora always paints — it's the base atmosphere and the 3D fallback. */}
      <Aurora intensity={show3d ? 0.7 : 1.1} />
      {show3d && (
        <div className="absolute inset-0">
          <HorizonScene />
        </div>
      )}
    </div>
  )
}
