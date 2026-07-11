import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

const INTERACTIVE = '[data-node-id], button, input, textarea, select, a, [role="textbox"], [contenteditable="true"]'
const DRAG_THRESHOLD_PX = 3

/**
 * Click-and-drag panning for a scroll container — grab empty canvas and drag to
 * move the view, like the Power Automate designer. Panning starts only from
 * empty canvas; clicks on nodes, buttons, and inputs pass through untouched.
 *
 * Returns handlers to spread on the scrollable element, a `panning` flag for
 * cursor styling, and `consumeMoved()` so the container's click handler can
 * tell a real click from the end of a drag (a pan must not also deselect).
 */
export function useCanvasPan(ref: RefObject<HTMLElement | null>) {
  const [panning, setPanning] = useState(false)
  const origin = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const moved = useRef(false)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest(INTERACTIVE)) return
      const el = ref.current
      if (!el) return
      origin.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }
      moved.current = false
      setPanning(true)
      el.setPointerCapture?.(event.pointerId)
    },
    [ref],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const start = origin.current
      const el = ref.current
      if (!start || !el) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) moved.current = true
      el.scrollLeft = start.left - dx
      el.scrollTop = start.top - dy
    },
    [ref],
  )

  const endPan = useCallback(
    (event: ReactPointerEvent) => {
      if (!origin.current) return
      origin.current = null
      setPanning(false)
      ref.current?.releasePointerCapture?.(event.pointerId)
    },
    [ref],
  )

  /** True when the pointer moved past the drag threshold since the last down — read once, then reset. */
  const consumeMoved = useCallback(() => {
    const wasDrag = moved.current
    moved.current = false
    return wasDrag
  }, [])

  return {
    panning,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endPan, onPointerLeave: endPan },
    consumeMoved,
  }
}
