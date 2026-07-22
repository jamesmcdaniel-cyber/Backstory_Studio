import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationHref } from '../href'

test('prefers the persisted link — a jam invite lands on its flow', () => {
  assert.equal(
    notificationHref({ type: 'flow.jam_invite', executionId: null, link: '/flows/abc123' }),
    '/flows/abc123',
  )
})

test('flow notifications without a link keep the activity-page fallback', () => {
  assert.equal(
    notificationHref({ type: 'flow.run_failed', executionId: 'flow9', link: null }),
    '/flows/flow9/activity',
  )
})

test('non-flow notifications keep the dashboard run fallback', () => {
  assert.equal(notificationHref({ type: 'agent.done', executionId: 'run1' }), '/agents?run=run1')
  assert.equal(notificationHref({ type: 'agent.done' }), '/dashboard')
})
