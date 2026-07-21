import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleFromCadence } from '../instantiate'

test('scheduleFromCadence: a periodic cadence becomes an ACTIVE schedule', () => {
  assert.deepEqual(scheduleFromCadence('weekly'), { type: 'weekly', timezone: 'UTC', isActive: true })
  assert.deepEqual(scheduleFromCadence('daily'), { type: 'daily', timezone: 'UTC', isActive: true })
  assert.deepEqual(scheduleFromCadence('cron'), { type: 'cron', timezone: 'UTC', isActive: true })
})

test('scheduleFromCadence: manual/empty/unknown becomes an inactive manual schedule', () => {
  assert.deepEqual(scheduleFromCadence('manual'), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence(''), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence(undefined), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence('nonsense'), { type: 'manual', timezone: 'UTC', isActive: false })
})
