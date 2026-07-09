import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFlowClipboard, readFlowClipboard, FLOW_CLIPBOARD_KEY } from '../clipboard'

function stubStorage() {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return store
}

test('write/read round-trips a step and sanitizes on read', () => {
  const store = stubStorage()
  writeFlowClipboard({ id: 'a', type: 'stop', data: { reason: 'x' } } as never)
  assert.ok(store.get(FLOW_CLIPBOARD_KEY))
  const read = readFlowClipboard()
  assert.equal(read?.type, 'stop')
})

test('read rejects garbage and triggers', () => {
  const store = stubStorage()
  store.set(FLOW_CLIPBOARD_KEY, 'not json')
  assert.equal(readFlowClipboard(), null)
  store.set(FLOW_CLIPBOARD_KEY, JSON.stringify({ id: 't', type: 'trigger', data: {} }))
  assert.equal(readFlowClipboard(), null)
})
