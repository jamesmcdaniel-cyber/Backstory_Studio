import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presenceColor, dedupeParticipants, type CollabParticipant } from '../use-flow-collab'

test('presenceColor is deterministic per user and a valid hex', () => {
  assert.equal(presenceColor('user-1'), presenceColor('user-1'))
  assert.match(presenceColor('user-1'), /^#[0-9a-f]{6}$/i)
  // Different users generally differ (not a hard guarantee, but these do).
  assert.notEqual(presenceColor('user-1'), presenceColor('user-2'))
})

test('dedupeParticipants collapses a user with multiple tabs to one, newest wins', () => {
  const list: CollabParticipant[] = [
    { clientId: 'a1', userId: 'u1', name: 'Ada', color: '#111' },
    { clientId: 'a2', userId: 'u1', name: 'Ada (2nd tab)', color: '#111' },
    { clientId: 'b1', userId: 'u2', name: 'Bo', color: '#222' },
  ]
  const out = dedupeParticipants(list)
  assert.equal(out.length, 2)
  assert.equal(out.find((p) => p.userId === 'u1')!.clientId, 'a2', 'the later tab wins')
  assert.ok(out.some((p) => p.userId === 'u2'))
})

test('dedupeParticipants drops entries with no userId', () => {
  const out = dedupeParticipants([{ clientId: 'x', userId: '', name: '', color: '#000' }])
  assert.equal(out.length, 0)
})
