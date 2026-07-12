import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  proposalToCreateTemplateArgs,
  proposalImprovementTarget,
} from '../accept-proposal'

// --- Pure (no DB): the proposal.configuration → createTemplate-args mapping. ---

test('proposalToCreateTemplateArgs: lifts name/category, nests the rest as configuration', () => {
  const args = proposalToCreateTemplateArgs({
    title: 'Fallback title',
    rationale: 'because usage says so',
    configuration: {
      name: 'Weekly Pipeline Digest',
      category: 'Sales',
      instructions: 'You summarize the pipeline.',
      integrations: ['Slack'],
      exampleOutput: 'A digest.',
      model: 'claude-sonnet-5',
      schedule: 'weekly',
    },
  })
  assert.equal(args.name, 'Weekly Pipeline Digest')
  assert.equal(args.category, 'Sales')
  assert.equal(args.description, 'because usage says so', 'description falls back to rationale')
  assert.deepEqual(args.configuration, {
    instructions: 'You summarize the pipeline.',
    integrations: ['Slack'],
    exampleOutput: 'A digest.',
    model: 'claude-sonnet-5',
    schedule: 'weekly',
  })
  // name/category are lifted OUT of the nested blob (they're AgentTemplate columns).
  assert.ok(!('name' in args.configuration))
  assert.ok(!('category' in args.configuration))
})

test('proposalToCreateTemplateArgs: sparse config falls back to the proposal title + Custom', () => {
  const args = proposalToCreateTemplateArgs({
    title: 'Bare proposal',
    rationale: 'r',
    configuration: {},
  })
  assert.equal(args.name, 'Bare proposal', 'name falls back to proposal.title')
  assert.equal(args.category, 'Custom', 'category defaults to Custom')
  assert.deepEqual(args.configuration, {})
})

test('proposalToCreateTemplateArgs: non-object configuration is tolerated', () => {
  const args = proposalToCreateTemplateArgs({
    title: 'T',
    rationale: 'r',
    configuration: null as never,
  })
  assert.equal(args.name, 'T')
  assert.deepEqual(args.configuration, {})
})

test('proposalImprovementTarget: returns a valid flow/agent target', () => {
  assert.deepEqual(
    proposalImprovementTarget({ configuration: { targetType: 'flow', targetId: 'flow-1', notes: 'x' } }),
    { targetType: 'flow', targetId: 'flow-1' },
  )
  assert.deepEqual(
    proposalImprovementTarget({ configuration: { targetType: 'agent', targetId: 'agent-9' } }),
    { targetType: 'agent', targetId: 'agent-9' },
  )
})

test('proposalImprovementTarget: null when targetType/targetId are absent or invalid', () => {
  assert.equal(proposalImprovementTarget({ configuration: {} }), null)
  assert.equal(proposalImprovementTarget({ configuration: { targetType: 'nope', targetId: 'x' } }), null)
  assert.equal(proposalImprovementTarget({ configuration: { targetType: 'flow' } }), null)
})
