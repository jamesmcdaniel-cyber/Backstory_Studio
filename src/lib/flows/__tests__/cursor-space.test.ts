import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toContentSpace } from '../cursor-space'

test('maps client coords into un-scaled content space', () => {
  // Content element visually starts at (100, 50); zoom 2 means every content
  // pixel paints as 2 screen pixels.
  assert.deepEqual(toContentSpace(300, 250, { left: 100, top: 50 }, 2), { x: 100, y: 100 })
})

test('zoom 1 is a plain offset', () => {
  assert.deepEqual(toContentSpace(120, 80, { left: 100, top: 50 }, 1), { x: 20, y: 30 })
})

test('guards a zero/negative zoom by treating it as 1', () => {
  assert.deepEqual(toContentSpace(120, 80, { left: 100, top: 50 }, 0), { x: 20, y: 30 })
})
