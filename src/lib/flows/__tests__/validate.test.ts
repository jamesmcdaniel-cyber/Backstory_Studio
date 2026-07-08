import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph, validationErrorMessage } from '../validate'

test('validateFlowGraph accepts a runnable agent flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{trigger.input}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Agent' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph reports missing agents and dangling edges', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'missing', input: 'x' } },
    ],
    edges: [{ id: 'bad', source: 'trigger', target: 'nope' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_AGENT'))
  assert.ok(result.errors.some((issue) => issue.code === 'DANGLING_EDGE'))
  assert.match(validationErrorMessage(result), /agent|edge|missing/i)
})

test('validateFlowGraph checks tool connection, tool name, and JSON args', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'missing_tool', args: '{"broken":' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_TOOL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON'))
})

test('validateFlowGraph checks required tool arguments from input schema', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"channel":"{{trigger.input.channel}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [
      {
        id: 'c1',
        tools: [
          {
            name: 'send',
            inputSchema: { type: 'object', required: ['channel', 'message'], properties: { channel: { type: 'string' }, message: { type: 'string' } } },
          },
        ],
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('message')))
  assert.ok(!result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('channel')))
})

test('validateFlowGraph accepts required object tool args supplied by exact data tokens', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'upsert', args: '{"record":"{{trigger.input.record}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [{ id: 'c1', tools: [{ name: 'upsert', inputSchema: { type: 'object', required: ['record'] } }] }],
  })
  assert.equal(result.ok, true)
})

test('validateFlowGraph checks loop bodies and switch defaults', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: [] } },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'c1', left: '{{trigger.input}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }, { id: 'e2', source: 'loop', target: 'sw' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_LOOP_BODY'))
  assert.ok(result.warnings.some((issue) => issue.code === 'MISSING_SWITCH_DEFAULT'))
})

test('validateFlowGraph allows saving an empty draft when runnable checks are disabled', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }
  assert.equal(validateFlowGraph(graph).ok, false)
  assert.equal(validateFlowGraph(graph, { requireRunnable: false }).ok, true)
})

test('validateFlowGraph checks trigger configuration', () => {
  const invalidType: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'mystery' } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(invalidType, { requireRunnable: false }).errors.some((issue) => issue.code === 'INVALID_TRIGGER_TYPE'))

  const missingCron: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule', schedule: { type: 'cron' } } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(missingCron, { requireRunnable: false }).errors.some((issue) => issue.code === 'MISSING_CRON'))

  const duplicateInputFields: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'manual', inputFields: [{ name: 'account', type: 'string' }, { name: 'account', type: 'number' }] } },
      },
    ],
    edges: [],
  }
  assert.ok(validateFlowGraph(duplicateInputFields, { requireRunnable: false }).errors.some((issue) => issue.code === 'DUPLICATE_INPUT_FIELD'))
})
