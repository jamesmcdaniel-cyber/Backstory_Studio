import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortStoredTemplates } from '../catalogue'

const d = (iso: string) => new Date(iso)

test('sortStoredTemplates ranks own ai_generated, then own user, then other-org global; newest-first within a group', () => {
  const rows = [
    { id: 'other-new', organizationId: 'orgB', source: 'user', visibility: 'global', updatedAt: d('2026-07-10') },
    { id: 'own-user-old', organizationId: 'orgA', source: 'user', visibility: 'org', updatedAt: d('2026-01-01') },
    { id: 'own-ai', organizationId: 'orgA', source: 'ai_generated', visibility: 'org', updatedAt: d('2026-02-01') },
    { id: 'own-user-new', organizationId: 'orgA', source: 'user', visibility: 'global', updatedAt: d('2026-07-01') },
    { id: 'other-old', organizationId: 'orgB', source: 'user', visibility: 'global', updatedAt: d('2026-01-01') },
  ]
  const sorted = sortStoredTemplates(rows, 'orgA').map((r) => r.id)
  assert.deepEqual(sorted, ['own-ai', 'own-user-new', 'own-user-old', 'other-new', 'other-old'])
})

test('sortStoredTemplates defaults missing source to user (own non-ai ranks in the user group)', () => {
  const rows = [
    { id: 'own-nosrc', organizationId: 'orgA', visibility: 'org', updatedAt: d('2026-03-01') },
    { id: 'own-ai', organizationId: 'orgA', source: 'ai_generated', visibility: 'org', updatedAt: d('2026-01-01') },
  ]
  assert.deepEqual(sortStoredTemplates(rows, 'orgA').map((r) => r.id), ['own-ai', 'own-nosrc'])
})
