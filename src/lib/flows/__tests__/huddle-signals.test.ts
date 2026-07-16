import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceHuddleSignal, type HuddleSignal } from '../huddle-signals'

const join = (from: string): HuddleSignal => ({ kind: 'join', from })

test('an existing member offers to a newcomer — one deterministic initiator per pair', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, [], join('peer')), [{ action: 'create-offer', peerId: 'peer' }])
})

test('not in the huddle → a join is ignored; duplicate joins do not re-offer', () => {
  assert.deepEqual(reduceHuddleSignal('me', false, [], join('peer')), [])
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], join('peer')), [])
})

test('own broadcasts are ignored', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, [], join('me')), [])
})

test('targeted offer/answer/ice apply only when addressed to us', () => {
  const offer: HuddleSignal = { kind: 'offer', from: 'peer', to: 'me', sdp: { type: 'offer' } }
  assert.deepEqual(reduceHuddleSignal('me', true, [], offer), [{ action: 'apply-offer', peerId: 'peer', sdp: { type: 'offer' } }])
  assert.deepEqual(reduceHuddleSignal('me', true, [], { ...offer, to: 'someone-else' }), [])
  const answer: HuddleSignal = { kind: 'answer', from: 'peer', to: 'me', sdp: { type: 'answer' } }
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], answer), [{ action: 'apply-answer', peerId: 'peer', sdp: { type: 'answer' } }])
  const ice: HuddleSignal = { kind: 'ice', from: 'peer', to: 'me', candidate: { candidate: 'x' } }
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], ice), [{ action: 'add-ice', peerId: 'peer', candidate: { candidate: 'x' } }])
})

test('leave closes a known peer and ignores unknown ones', () => {
  assert.deepEqual(reduceHuddleSignal('me', true, ['peer'], { kind: 'leave', from: 'peer' }), [{ action: 'close', peerId: 'peer' }])
  assert.deepEqual(reduceHuddleSignal('me', true, [], { kind: 'leave', from: 'stranger' }), [])
})
