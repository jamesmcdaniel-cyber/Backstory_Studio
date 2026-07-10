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

test('validateFlowGraph checks tool connection, tool name, and object-shaped JSON args', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'missing_tool', args: '{"broken":' } },
      { id: 'arr', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '[]' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }, { id: 'e2', source: 't', target: 'arr' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_TOOL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 't'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 'arr'))
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

test('validateFlowGraph checks HTTP request configuration', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'bad-url', type: 'http', data: { method: 'POST', url: 'ftp://example.com', headers: '[]', query: '"bad"', bodyMode: 'json', body: '{broken' } },
      { id: 'insecure-url', type: 'http', data: { method: 'POST', url: 'http://api.example.com' } },
      { id: 'get-body', type: 'http', data: { method: 'GET', url: 'https://api.example.com', body: '{"ignored":true}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bad-url' },
      { id: 'e2', source: 'bad-url', target: 'insecure-url' },
      { id: 'e3', source: 'insecure-url', target: 'get-body' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL' && issue.message.includes('https://') && issue.nodeId === 'insecure-url'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('headers')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('query')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON' && issue.message.includes('body')))
  assert.ok(result.warnings.some((issue) => issue.code === 'HTTP_BODY_IGNORED'))
})

test('validateFlowGraph warns when an http step authenticates with an unavailable connection', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'gone' } },
      { id: 'h2', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'c1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h1' }, { id: 'e2', source: 'h1', target: 'h2' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [] }] })
  assert.equal(result.ok, true) // warning only — never blocks a run
  assert.ok(result.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h1'))
  assert.ok(!result.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h2'))
  // No catalog context (e.g. plain graph checks): no warning either
  const noContext = validateFlowGraph(graph)
  assert.ok(!noContext.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION'))
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

test('warns when a step maps fields from a text-only agent', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: 'score: {{step.a1.output.score}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.ok(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF' && w.nodeId === 'h1'))
})

test('no field-ref warning for structured agents or whole-output references', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: '{{step.a1.output.score}} and {{step.a1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.equal(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF'), false)
})
