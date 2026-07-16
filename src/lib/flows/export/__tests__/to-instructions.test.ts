import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { flowToInstructions } from '../to-instructions'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
    { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api.example.com/{{trigger.input.id}}', label: 'Fetch account' } },
    { id: 'a1', type: 'agent', data: { agentId: 'x', input: 'Summarize {{step.h1.output.body}}', label: 'Summarize' } },
    { id: 't1', type: 'tool', data: { connectionId: 'c', toolName: 'slack_post_message', label: 'Post to Slack' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'h1' },
    { id: 'e1', source: 'h1', target: 'a1' },
    { id: 'e2', source: 'a1', target: 't1' },
  ],
}

test('flowToInstructions produces copilot-ready markdown with trigger + ordered steps', () => {
  const md = flowToInstructions({ name: 'Lead brief', description: 'Brief a new lead.', graph })
  assert.ok(md.startsWith('# Lead brief'))
  assert.ok(md.includes('AI builder'), 'has the copilot framing')
  assert.ok(md.includes('## Trigger') && md.includes('webhook'))
  // Steps are ordered from the trigger and numbered.
  const fetchIdx = md.indexOf('Fetch account')
  const summarizeIdx = md.indexOf('Summarize')
  const slackIdx = md.indexOf('Post to Slack')
  assert.ok(fetchIdx > 0 && summarizeIdx > fetchIdx && slackIdx > summarizeIdx, 'steps in flow order')
})

test('flowToInstructions describes tokens in plain English (no {{}} left)', () => {
  const md = flowToInstructions({ name: 'x', graph })
  assert.ok(!md.includes('{{'), 'no raw token syntax leaks into the guide')
  assert.ok(md.includes('the “id” from the trigger data'))
  assert.ok(md.includes('from “Fetch account”'))
})

test('flowToInstructions lists connections and never drops steps', () => {
  const md = flowToInstructions({ name: 'x', graph })
  assert.ok(md.includes('## Connections'))
  assert.ok(md.includes('slack_post_message'))
  // All three steps appear.
  for (const label of ['Fetch account', 'Summarize', 'Post to Slack']) assert.ok(md.includes(label))
})
