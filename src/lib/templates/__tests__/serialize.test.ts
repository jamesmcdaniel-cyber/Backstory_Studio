import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeTemplate } from '../catalogue'

const row = {
  id: 't1',
  name: 'Renewal watcher',
  description: 'Watches renewals',
  type: 'Sales',
  configuration: { instructions: 'do it', integrations: ['salesforce'], skills: [], tags: ['renewal'], model: 'gpt-4o', authorName: 'Rep A' },
  source: 'ai_generated',
  visibility: 'org',
  organizationId: 'orgA',
}

test('serializeTemplate exposes source, visibility, and mine', () => {
  const out = serializeTemplate(row, 'orgA')
  assert.equal(out.source, 'ai_generated')
  assert.equal(out.visibility, 'org')
  assert.equal(out.mine, true)
  assert.equal(out.category, 'Sales')
  assert.ok(out.instructions.startsWith('do it'))
  assert.match(out.instructions, /Automation asset quality contract/)
})

test('serializeTemplate marks mine=false for another org and defaults missing provenance', () => {
  const out = serializeTemplate({ ...row, source: undefined, visibility: undefined }, 'orgB')
  assert.equal(out.mine, false)
  assert.equal(out.source, 'user')      // defaults when absent
  assert.equal(out.visibility, 'org')
})

test('serializeTemplate leaves user-authored instructions unchanged', () => {
  const out = serializeTemplate({ ...row, source: 'user', configuration: { instructions: 'Keep this exact.' } }, 'orgA')
  assert.equal(out.instructions, 'Keep this exact.')
})
