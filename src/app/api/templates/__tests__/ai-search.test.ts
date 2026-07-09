import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMatches, sanitizeMatches, type CatalogItem } from '@/lib/templates/ai-search'

// ── parseMatches ─────────────────────────────────────────────────────────

test('parseMatches: parses plain JSON', () => {
  const raw = JSON.stringify({ matches: [{ id: 't1', reason: 'Because it fits.' }] })
  assert.deepEqual(parseMatches(raw), [{ id: 't1', reason: 'Because it fits.' }])
})

test('parseMatches: strips a ```json fenced code block', () => {
  const raw = '```json\n' + JSON.stringify({ matches: [{ id: 't1', reason: 'Fenced.' }] }) + '\n```'
  assert.deepEqual(parseMatches(raw), [{ id: 't1', reason: 'Fenced.' }])
})

test('parseMatches: strips a bare ``` fenced code block (no language tag)', () => {
  const raw = '```\n' + JSON.stringify({ matches: [{ id: 't2', reason: 'Also fenced.' }] }) + '\n```'
  assert.deepEqual(parseMatches(raw), [{ id: 't2', reason: 'Also fenced.' }])
})

test('parseMatches: garbage/unparsable text returns []', () => {
  assert.deepEqual(parseMatches('not json at all {{{'), [])
})

test('parseMatches: empty string returns []', () => {
  assert.deepEqual(parseMatches(''), [])
})

test('parseMatches: valid JSON missing a matches array returns []', () => {
  assert.deepEqual(parseMatches(JSON.stringify({ foo: 'bar' })), [])
})

test('parseMatches: matches entries missing id are dropped', () => {
  const raw = JSON.stringify({ matches: [{ reason: 'no id here' }, { id: 't1', reason: 'ok' }] })
  assert.deepEqual(parseMatches(raw), [{ id: 't1', reason: 'ok' }])
})

// ── sanitizeMatches ──────────────────────────────────────────────────────

const items: CatalogItem[] = [
  { id: 't1', kind: 'template', name: 'Weekly digest', description: 'd', category: 'Sales' },
  { id: 's1', kind: 'skill', name: 'Summarize notes', description: 'd', category: 'Productivity' },
]

test('sanitizeMatches: keeps matches whose id is present in items, with kind looked up', () => {
  const out = sanitizeMatches([{ id: 't1', reason: 'good fit' }], items)
  assert.deepEqual(out, [{ id: 't1', kind: 'template', reason: 'good fit' }])
})

test('sanitizeMatches: filters out hallucinated ids not present in items', () => {
  const out = sanitizeMatches(
    [
      { id: 't1', reason: 'real' },
      { id: 'does-not-exist', reason: 'hallucinated' },
    ],
    items,
  )
  assert.deepEqual(out, [{ id: 't1', kind: 'template', reason: 'real' }])
})

test('sanitizeMatches: caps output at 5 even when more valid matches are given', () => {
  const manyItems: CatalogItem[] = Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    kind: 'template' as const,
    name: `Template ${i}`,
    description: 'd',
    category: 'Sales',
  }))
  const manyMatches = manyItems.map((item) => ({ id: item.id, reason: `reason ${item.id}` }))
  const out = sanitizeMatches(manyMatches, manyItems)
  assert.equal(out.length, 5)
  assert.deepEqual(out.map((m) => m.id), ['t0', 't1', 't2', 't3', 't4'])
})

test('sanitizeMatches: de-duplicates repeated ids', () => {
  const out = sanitizeMatches(
    [
      { id: 't1', reason: 'first' },
      { id: 't1', reason: 'dup' },
    ],
    items,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].reason, 'first')
})

test('sanitizeMatches: empty matches input returns []', () => {
  assert.deepEqual(sanitizeMatches([], items), [])
})
