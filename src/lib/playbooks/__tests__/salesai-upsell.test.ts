import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { buildUpsellGraph, PLAYBOOK_AGENTS } from '../salesai-upsell'

test('buildUpsellGraph produces a schema-valid, fully wired graph', () => {
  const graph = flowGraphSchema.parse(buildUpsellGraph({ puller: 'a1', scorer: 'a2', composer: 'a3' }))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  // agents wired to the provided ids
  const pull = byId.get('pull')
  const score = byId.get('score')
  const brief = byId.get('brief')
  assert.equal(pull?.type === 'agent' && pull.data.agentId, 'a1')
  assert.equal(score?.type === 'agent' && score.data.agentId, 'a2')
  assert.equal(brief?.type === 'agent' && brief.data.agentId, 'a3')
  // loop contains the scorer and reads the puller's output
  const loop = byId.get('score_each')
  assert.ok(loop?.type === 'loop' && loop.data.body.includes('score') && loop.data.over.includes('step.pull.output'))
  // chain: trigger -> pull -> loop -> brief
  const chain = graph.edges.map((e) => `${e.source}>${e.target}`)
  assert.deepEqual(chain, ['trigger>pull', 'pull>score_each', 'score_each>brief'])
})

test('playbook agents carry the strata keys their tools need', () => {
  assert.ok(PLAYBOOK_AGENTS.puller.integrations.includes('strata:snowflake'))
  assert.ok(PLAYBOOK_AGENTS.scorer.integrations.includes('strata:snowflake'))
  assert.ok(PLAYBOOK_AGENTS.composer.integrations.includes('strata:slack'))
})
