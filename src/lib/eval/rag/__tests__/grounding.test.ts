import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateGroundedAnswer, isRefusal, REFUSAL_SENTINEL, EVAL_GROUNDING_INSTRUCTION } from '../answer'
import { judgeGrounding } from '../judge'

test('generateGroundedAnswer passes the grounding instruction and returns the model answer', async () => {
  let seenSystem = ''
  const fake = async (opts: { system: string }) => {
    seenSystem = opts.system
    return JSON.stringify({ answer: 'Growth is $75 per seat.' })
  }
  const answer = await generateGroundedAnswer('How much is Growth?', '## Knowledge\nGrowth is $75/seat/month.', { generate: fake as never })
  assert.equal(answer, 'Growth is $75 per seat.')
  assert.ok(seenSystem.includes(EVAL_GROUNDING_INSTRUCTION))
})

test('isRefusal detects the sentinel case-insensitively and ignores substantive answers', () => {
  assert.equal(isRefusal(REFUSAL_SENTINEL), true)
  assert.equal(isRefusal('I DO NOT have enough information to answer that, sorry.'), true)
  assert.equal(isRefusal('Growth is $75 per seat per month.'), false)
})

test('judgeGrounding clamps the judge scores into [0,1]', async () => {
  const fake = async () => JSON.stringify({ faithfulness: 1.4, answerRelevance: -0.2, reasoning: 'x' })
  const scores = await judgeGrounding('q', 'a', 'ctx', { generate: fake as never })
  assert.equal(scores.faithfulness, 1)
  assert.equal(scores.answerRelevance, 0)
})
