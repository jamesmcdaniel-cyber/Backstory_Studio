import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tiltFromPointer, clamp, staggerContainer, TILT_REST } from '../motion'

const rect = { left: 0, top: 0, width: 200, height: 100 }

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(99, 0, 10), 10)
})

test('tiltFromPointer: center pointer is flat with centered glare', () => {
  const t = tiltFromPointer(100, 50, rect, 8)
  assert.equal(t.rotateX, 0)
  assert.equal(t.rotateY, 0)
  assert.equal(t.glareX, 50)
  assert.equal(t.glareY, 50)
})

test('tiltFromPointer: card leans toward the cursor', () => {
  // Pointer at top-right corner.
  const t = tiltFromPointer(200, 0, rect, 8)
  assert.ok(t.rotateY > 0, 'right edge swings forward (positive rotateY)')
  assert.ok(t.rotateX > 0, 'top tips back → positive rotateX (from -ny, ny<0)')
  assert.equal(t.glareX, 100)
  assert.equal(t.glareY, 0)
})

test('tiltFromPointer: clamps pointers outside the rect', () => {
  const t = tiltFromPointer(9999, 9999, rect, 8)
  assert.equal(t.rotateY, 8, 'maxDeg reached at the far edge, not exceeded')
  assert.equal(t.rotateX, -8)
  assert.equal(t.glareX, 100)
  assert.equal(t.glareY, 100)
})

test('tiltFromPointer: zero-size rect is a safe no-op', () => {
  const t = tiltFromPointer(10, 10, { left: 0, top: 0, width: 0, height: 0 })
  assert.deepEqual(t, TILT_REST)
})

test('staggerContainer wires staggerChildren + delayChildren', () => {
  const v = staggerContainer(0.1, 0.2)
  const show = v.show as { transition: { staggerChildren: number; delayChildren: number } }
  assert.equal(show.transition.staggerChildren, 0.1)
  assert.equal(show.transition.delayChildren, 0.2)
})
