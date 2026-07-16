/**
 * Convert a pointer's client (viewport) coords into canvas CONTENT space —
 * the un-scaled coordinate system nodes are laid out in. `rect` is the
 * bounding rect of the zoom-TRANSFORMED content element, so dividing by zoom
 * undoes the visual scale. A cursor parked on a node then shows on that node
 * for every viewer regardless of their own pan/zoom.
 */
export function toContentSpace(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1
  return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z }
}
