import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksSchedule, STALE_WAITING_BLOCK_MS } from '../schedule-blocking'

const now = new Date('2026-07-10T12:00:00Z')
const agoMs = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 60 * 60 * 1000

test('a running run always blocks the schedule, however old', () => {
  assert.equal(blocksSchedule({ status: 'running', startedAt: agoMs(1000) }, now), true)
  assert.equal(blocksSchedule({ status: 'running', startedAt: agoMs(48 * HOUR) }, now), true)
})

test('a waiting run blocks only while younger than 24h', () => {
  assert.equal(blocksSchedule({ status: 'waiting', startedAt: agoMs(HOUR) }, now), true)
  assert.equal(blocksSchedule({ status: 'waiting', startedAt: agoMs(23 * HOUR) }, now), true)
  assert.equal(blocksSchedule({ status: 'waiting', startedAt: agoMs(25 * HOUR) }, now), false)
  // Boundary: exactly 24h old no longer blocks.
  assert.equal(blocksSchedule({ status: 'waiting', startedAt: agoMs(STALE_WAITING_BLOCK_MS) }, now), false)
})

test('terminal runs never block', () => {
  for (const status of ['succeeded', 'failed', 'stopped', 'resumed']) {
    assert.equal(blocksSchedule({ status, startedAt: agoMs(1000) }, now), false)
  }
})
