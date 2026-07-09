import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReflection, buildReflectionPrompt } from '../reflection'

test('parseReflection accepts clean JSON', () => {
  const parsed = parseReflection(JSON.stringify({
    learnings: [{ title: 'Snowflake table', content: 'Upsell data lives in ANALYTICS.UPSELL' }],
    selfCritique: 'Query Snowflake before Salesforce next time.',
    suggestions: [{ title: 'Connect Salesforce', rationale: 'SOQL segmentation needs it', actionType: 'connect' }],
    goalAssessment: 'Partially served the goal.',
  }))
  assert.equal(parsed?.learnings[0].title, 'Snowflake table')
  assert.equal(parsed?.suggestions[0].actionType, 'connect')
})

test('parseReflection tolerates code fences and drops invalid actionType', () => {
  const fenced = '```json\n' + JSON.stringify({
    learnings: [], selfCritique: 'ok', suggestions: [{ title: 'x', rationale: 'y', actionType: 'weird' }], goalAssessment: '',
  }) + '\n```'
  const parsed = parseReflection(fenced)
  assert.equal(parsed?.suggestions[0].actionType, 'other')
})

test('parseReflection returns null on garbage', () => {
  assert.equal(parseReflection('not json at all'), null)
  assert.equal(parseReflection('{"learnings": "nope"}'), null)
})

test('buildReflectionPrompt includes goal, objective, summary, log', () => {
  const { system, user } = buildReflectionPrompt({
    goal: 'Grow upsell pipeline', objective: 'Score accounts', summary: 'Scored 12 accounts', processLog: 'tool: search…',
  })
  assert.match(system, /reflection/i)
  assert.match(user, /Grow upsell pipeline/)
  assert.match(user, /Score accounts/)
  assert.match(user, /Scored 12 accounts/)
})

test('reflectAndRemember calls generate with the built prompt and tolerates downstream failure', async () => {
  const { reflectAndRemember } = await import('../reflection')
  let captured: { system: string; user: string } | null = null
  const result = await reflectAndRemember(
    {
      organizationId: 'org', agentId: 'agent', executionId: 'exec',
      goal: null, objective: 'obj', summary: 'sum', processLog: 'log',
      recordSuggestionEvent: async () => undefined,
    },
    {
      generate: async (opts) => {
        captured = { system: opts.system, user: opts.user }
        throw new Error('stop before DB writes')
      },
    },
  )
  assert.equal(result, null)
  assert.match(captured!.user, /infer one/)
})
