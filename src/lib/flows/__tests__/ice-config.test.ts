import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iceServersFromEnv } from '../ice-config'

test('STUN always present; TURN appended only with full config', () => {
  assert.deepEqual(iceServersFromEnv({}), [{ urls: 'stun:stun.l.google.com:19302' }])
  assert.deepEqual(
    iceServersFromEnv({ TURN_URL: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' }),
    [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' },
    ],
  )
})

test('partial TURN config stays STUN-only; comma list becomes an array', () => {
  assert.deepEqual(iceServersFromEnv({ TURN_URL: 'turn:x', TURN_USERNAME: 'u' }), [
    { urls: 'stun:stun.l.google.com:19302' },
  ])
  const out = iceServersFromEnv({ TURN_URL: 'turn:a, turns:b', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' })
  assert.deepEqual(out[1].urls, ['turn:a', 'turns:b'])
})
