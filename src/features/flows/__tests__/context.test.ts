import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPath, resolveTemplate, resolveTemplateValue, asStructured, evalCondition, evalClause, type FlowContext } from '../context'

const ctx: FlowContext = {
  trigger: { input: 'Acme, Globex' },
  step: { n1: { output: '["Acme","Globex"]' }, n3: { output: { score: 91 } } },
  item: 'Acme',
}

test('readPath reads trigger, nested step output, and item', () => {
  assert.equal(readPath(ctx, 'trigger.input'), 'Acme, Globex')
  assert.equal(readPath(ctx, 'step.n3.output.score'), 91)
  assert.equal(readPath(ctx, 'item'), 'Acme')
  assert.equal(readPath(ctx, 'step.nope.output'), undefined)
})

test('readPath reads now / flow / run roots; unknown subpaths → undefined', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: {},
    now: { iso: '2026-07-12T09:30:00.000Z', date: '2026-07-12', time: '09:30:00', unix: 1_752_312_600 },
    run: { id: 'r1', url: '/flows/f1?run=r1', trigger: 'manual', startedAt: '2026-07-12T09:00:00.000Z', flowId: 'f1', flowName: 'Digest' },
  }
  assert.equal(readPath(c, 'now'), '2026-07-12T09:30:00.000Z')
  assert.equal(readPath(c, 'now.date'), '2026-07-12')
  assert.equal(readPath(c, 'now.time'), '09:30:00')
  assert.equal(readPath(c, 'now.unix'), 1_752_312_600)
  assert.equal(readPath(c, 'flow.id'), 'f1')
  assert.equal(readPath(c, 'flow.name'), 'Digest')
  assert.equal(readPath(c, 'run.id'), 'r1')
  assert.equal(readPath(c, 'run.startedAt'), '2026-07-12T09:00:00.000Z')
  assert.equal(readPath(c, 'run.trigger'), 'manual')
  assert.equal(readPath(c, 'run.url'), '/flows/f1?run=r1')
  // Unknown subpaths never crash — they read as undefined (→ '' when templated).
  assert.equal(readPath(c, 'run.bogus'), undefined)
  assert.equal(readPath(c, 'flow.bogus'), undefined)
  assert.equal(readPath(c, 'now.bogus'), undefined)
})

test('now / flow / run tokens resolve to empty when the context lacks them', () => {
  const c: FlowContext = { trigger: { input: '' }, step: {} }
  assert.equal(resolveTemplate('{{now}}|{{run.id}}|{{flow.name}}', c), '||')
})

test('resolveTemplate substitutes tokens; missing → empty; objects → JSON', () => {
  assert.equal(resolveTemplate('Score {{item}}', ctx), 'Score Acme')
  assert.equal(resolveTemplate('{{step.n3.output}}', ctx), '{"score":91}')
  assert.equal(resolveTemplate('x{{step.missing.output}}y', ctx), 'xy')
})

test('resolveTemplate supports field names with spaces and dashes', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n1: { output: { 'account-name': 'Acme', 'in segment': true } } },
  }
  assert.equal(resolveTemplate('{{step.n1.output.account-name}}', c), 'Acme')
  assert.equal(resolveTemplate('{{step.n1.output.in segment}}', c), 'true')
})

test('resolveTemplateValue preserves exact-token structured values', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n1: { output: { name: 'Acme', score: 91 } } },
  }
  assert.deepEqual(resolveTemplateValue({ account: '{{step.n1.output}}', label: 'Account {{step.n1.output.name}}' }, c), {
    account: { name: 'Acme', score: 91 },
    label: 'Account Acme',
  })
})

test('asStructured parses JSON strings, passes through non-JSON', () => {
  assert.deepEqual(asStructured('["a","b"]'), ['a', 'b'])
  assert.equal(asStructured('hello'), 'hello')
  assert.deepEqual(asStructured({ a: 1 }), { a: 1 })
})

test('evalCondition handles numeric and string ops (legacy single clause)', () => {
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'gt', right: '80' }, ctx), true)
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'lt', right: '80' }, ctx), false)
  assert.equal(evalCondition({ left: '{{trigger.input}}', op: 'contains', right: 'Globex' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'eq', right: 'Acme' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'matches', right: '^Ac' }, ctx), true)
})

test('evalClause templates the right-hand side (dynamic comparison)', () => {
  const c: FlowContext = { trigger: { input: '80' }, step: { s: { output: { score: 91 } } } }
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'gt', right: '{{trigger.input}}' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'lt', right: '{{trigger.input}}' }, c), false)
})

test('evalClause trims resolved string operands (chip insertion leaves trailing spaces)', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { s: { output: { stage: 'enterprise ', notes: 'the enterprise tier' } } },
  }
  // eq: trailing space from a chip insert on either side still matches.
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'eq', right: 'enterprise' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.stage}} ', op: 'eq', right: ' enterprise ' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'neq', right: 'enterprise' }, c), false)
  // contains: a trailing-space needle still matches.
  assert.equal(evalClause({ left: '{{step.s.output.notes}}', op: 'contains', right: 'enterprise ' }, c), true)
  // matches: a padded pattern still compiles and matches.
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'matches', right: ' ^enter ' }, c), true)
})

test('evalClause numeric comparisons still work with padded numerics', () => {
  const c: FlowContext = { trigger: { input: ' 80 ' }, step: { s: { output: { score: '91 ' } } } }
  assert.equal(evalClause({ left: '{{step.s.output.score}} ', op: 'gt', right: '{{trigger.input}}' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'lte', right: '{{trigger.input}}' }, c), false)
  assert.equal(evalClause({ left: ' 91 ', op: 'eq', right: '91' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'gte', right: '91' }, c), true)
})

test('evalClause leaves non-string operands from structured outputs intact', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { s: { output: { score: 91, active: true, ratio: 0.5 } } },
  }
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'eq', right: '91' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.active}}', op: 'eq', right: 'true' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.ratio}}', op: 'lt', right: '1' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}} ', op: 'gt', right: '90' }, c), true)
})

test('friendly step-label tokens resolve like canonical step.<id> tokens', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n2: { output: 'Qualified: strong enterprise fit.' } },
    stepAliases: { 'previous agent': 'n2' },
  }
  // The exact hand-typed shape from the bug report: label root + .output.message
  // on a plain-text agent output.
  assert.equal(resolveTemplate('{{Previous Agent.output.message}}', c), 'Qualified: strong enterprise fit.')
  // Label in the step slot, case/spacing-insensitive, with or without .output.
  assert.equal(resolveTemplate('{{step.Previous Agent.output}}', c), 'Qualified: strong enterprise fit.')
  assert.equal(resolveTemplate('{{  previous   agent  .output}}', c), 'Qualified: strong enterprise fit.')
  assert.equal(resolveTemplate('{{Previous Agent.text}}', c), 'Qualified: strong enterprise fit.')
})

test('friendly-label tokens read REAL fields off structured outputs', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n2: { output: { message: 'hi', score: 91 } } },
    stepAliases: { 'previous agent': 'n2' },
  }
  assert.equal(resolveTemplate('{{Previous Agent.output.message}}', c), 'hi')
  assert.equal(resolveTemplate('{{Previous Agent.score}}', c), '91')
})

test('text-ish field names on a plain-text output mean the text itself', () => {
  const c: FlowContext = { trigger: { input: '' }, step: { n2: { output: 'plain text' } } }
  assert.equal(resolveTemplate('{{step.n2.output.message}}', c), 'plain text')
  assert.equal(resolveTemplate('{{step.n2.output.summary}}', c), 'plain text')
  // A non-text-ish field on plain text is still empty — no invented data.
  assert.equal(resolveTemplate('{{step.n2.output.score}}', c), '')
})

test('JSON-text outputs walk structured on field access', () => {
  assert.equal(resolveTemplate('{{step.n1.output.0}}', ctx), 'Acme')
})

test('onMissing reports broken references, not legitimately-empty ones', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n2: { output: 'x' } },
    stepAliases: { 'previous agent': 'n2' },
  }
  const missing: string[] = []
  const out = resolveTemplate('{{Bogus Step.output}}|{{step.zz.output}}|{{var.unset}}|{{Previous Agent.output}}', c, (p) => missing.push(p))
  assert.equal(out, '|||x')
  assert.deepEqual(missing, ['Bogus Step.output', 'step.zz.output'])
  // Exact-token structured values report through the same channel.
  const missing2: string[] = []
  assert.deepEqual(resolveTemplateValue({ query: '{{Bogus Step.output}}' }, c, (p) => missing2.push(p)), { query: '' })
  assert.deepEqual(missing2, ['Bogus Step.output'])
})

test('evalCondition combines clauses with all (AND) / any (OR)', () => {
  const pass = { left: '{{step.n3.output.score}}', op: 'gt' as const, right: '80' }
  const fail = { left: '{{item}}', op: 'eq' as const, right: 'Globex' }
  assert.equal(evalCondition({ match: 'all', clauses: [pass, fail] }, ctx), false)
  assert.equal(evalCondition({ match: 'any', clauses: [pass, fail] }, ctx), true)
  assert.equal(evalCondition({ match: 'all', clauses: [pass] }, ctx), true)
})
