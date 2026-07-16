import { test } from 'node:test'
import assert from 'node:assert/strict'
import { electPersister, shouldAnswerBootstrap, shouldRecordJamAudit } from '../collab-roles'

test('electPersister prefers the owner, then lowest clientId, order-independently', () => {
  const room = [
    { clientId: 'c', userId: 'u2', canEdit: true },
    { clientId: 'b', userId: 'owner', canEdit: true },
    { clientId: 'a', userId: 'u3', canEdit: true },
  ]
  assert.equal(electPersister(room, 'owner'), 'b')
  assert.equal(electPersister([...room].reverse(), 'owner'), 'b', 'input order must not matter')
  assert.equal(electPersister(room, null), 'a', 'no owner present → lowest editor clientId')
})

test('electPersister with the owner on two tabs picks the owner tab with the lowest clientId', () => {
  const room = [
    { clientId: 'z2', userId: 'owner', canEdit: true },
    { clientId: 'z1', userId: 'owner', canEdit: true },
    { clientId: 'a', userId: 'u2', canEdit: true },
  ]
  assert.equal(electPersister(room, 'owner'), 'z1')
})

test('electPersister ignores view-only participants; empty/no-editor rooms elect nobody', () => {
  assert.equal(electPersister([{ clientId: 'a', userId: 'u1', canEdit: false }], null), null)
  assert.equal(electPersister([], 'owner'), null)
})

test('shouldAnswerBootstrap: exactly the lowest already-present client answers', () => {
  const present = ['c', 'a', 'newbie', 'b']
  assert.equal(shouldAnswerBootstrap(present, 'newbie', 'a'), true)
  assert.equal(shouldAnswerBootstrap(present, 'newbie', 'b'), false)
  assert.equal(shouldAnswerBootstrap(['newbie'], 'newbie', 'newbie'), false, 'nobody else present → no answer needed')
})

test('shouldRecordJamAudit coalesces to one audit per window', () => {
  const tenMin = 10 * 60 * 1000
  assert.equal(shouldRecordJamAudit(0, tenMin), true)
  assert.equal(shouldRecordJamAudit(1_000, tenMin), false)
  assert.equal(shouldRecordJamAudit(1_000, 1_000 + tenMin), true)
})
