import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldGenerateNow, GENERATION_DEBOUNCE_MS } from '../generation-queue'

// The pure debounce decision — the cost-bounding heart of the gated generation
// job. It is the SAME decision the gate-clear hook and the daily cron sweep make
// before ever enqueuing a (billed) model call, so it is exercised directly here.

const NOW = new Date('2026-07-12T12:00:00.000Z')

test('below the integration gate → never generate', () => {
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: null, hasOpenProposals: false, now: NOW, meetsGate: false }),
    false,
  )
})

test('a recent generation (within the debounce window) → skip (cost bound)', () => {
  const recent = new Date(NOW.getTime() - (GENERATION_DEBOUNCE_MS - 60_000))
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: recent, hasOpenProposals: false, now: NOW, meetsGate: true }),
    false,
  )
})

test('open proposals already waiting → skip (do not pile up the review queue)', () => {
  const stale = new Date(NOW.getTime() - 2 * GENERATION_DEBOUNCE_MS)
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: stale, hasOpenProposals: true, now: NOW, meetsGate: true }),
    false,
  )
})

test('gate met + no open proposals + stale last generation → generate', () => {
  const stale = new Date(NOW.getTime() - (GENERATION_DEBOUNCE_MS + 60_000))
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: stale, hasOpenProposals: false, now: NOW, meetsGate: true }),
    true,
  )
})

test('gate met + never generated before + no open proposals → generate', () => {
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: null, hasOpenProposals: false, now: NOW, meetsGate: true }),
    true,
  )
})

test('exactly at the debounce boundary is still too recent (strictly older than the window wins)', () => {
  const exactlyWindow = new Date(NOW.getTime() - GENERATION_DEBOUNCE_MS)
  assert.equal(
    shouldGenerateNow({ lastGeneratedAt: exactlyWindow, hasOpenProposals: false, now: NOW, meetsGate: true }),
    false,
  )
})
