import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useRef } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { useCanvasPan } from '../use-canvas-pan'

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window
function pointer(type: string, x: number, y: number, target: HTMLElement) {
  const e = new (win() as unknown as { Event: typeof Event }).Event(type, { bubbles: true }) as unknown as Record<string, unknown>
  e.clientX = x; e.clientY = y; e.button = 0; e.pointerId = 1
  Object.defineProperty(e, 'target', { value: target })
  return e as unknown as PointerEvent
}

function Harness({ probe }: { probe: (api: ReturnType<typeof useCanvasPan>) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const api = useCanvasPan(ref)
  probe(api)
  return React.createElement('div', {
    ref, 'data-testid': 'canvas',
    onPointerDown: api.handlers.onPointerDown, onPointerMove: api.handlers.onPointerMove, onPointerUp: api.handlers.onPointerUp,
  }, React.createElement('button', { 'data-testid': 'btn' }, 'x'))
}

test('drag on empty canvas pans (scrollLeft/Top follow the delta) and marks moved', () => {
  let api!: ReturnType<typeof useCanvasPan>
  const { container } = render(React.createElement(Harness, { probe: (a) => { api = a } }))
  const canvas = container.querySelector('[data-testid="canvas"]') as HTMLDivElement
  canvas.scrollLeft = 100; canvas.scrollTop = 50
  act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 200, canvas)) })
  act(() => { canvas.dispatchEvent(pointer('pointermove', 170, 180, canvas)) }) // dx -30, dy -20
  assert.equal(canvas.scrollLeft, 130) // 100 - (-30)
  assert.equal(canvas.scrollTop, 70)   // 50 - (-20)
  assert.equal(api.consumeMoved(), true)
  act(() => { canvas.dispatchEvent(pointer('pointerup', 170, 180, canvas)) })
  cleanup()
})

test('pointerdown on an interactive element (button) does NOT start a pan', () => {
  let api!: ReturnType<typeof useCanvasPan>
  const { container } = render(React.createElement(Harness, { probe: (a) => { api = a } }))
  const canvas = container.querySelector('[data-testid="canvas"]') as HTMLDivElement
  const btn = container.querySelector('[data-testid="btn"]') as HTMLElement
  canvas.scrollLeft = 0
  act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 200, btn)) })
  act(() => { canvas.dispatchEvent(pointer('pointermove', 100, 200, canvas)) })
  assert.equal(canvas.scrollLeft, 0) // no pan happened
  assert.equal(api.consumeMoved(), false)
  cleanup()
})

test('a click without drag reports not-moved (deselect still fires)', () => {
  let api!: ReturnType<typeof useCanvasPan>
  const { container } = render(React.createElement(Harness, { probe: (a) => { api = a } }))
  const canvas = container.querySelector('[data-testid="canvas"]') as HTMLDivElement
  act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 200, canvas)) })
  act(() => { canvas.dispatchEvent(pointer('pointermove', 201, 201, canvas)) }) // 1px < threshold
  act(() => { canvas.dispatchEvent(pointer('pointerup', 201, 201, canvas)) })
  assert.equal(api.consumeMoved(), false)
  cleanup()
})
