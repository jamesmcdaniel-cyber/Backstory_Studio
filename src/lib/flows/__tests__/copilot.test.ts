import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { repairGeneratedFlowGraph, validationIssuesForModel } from '../copilot'
import { validateFlowGraph } from '../validate'

test('repairGeneratedFlowGraph prunes unknown agents and dangling edges', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'good', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'bad', type: 'agent', data: { agentId: 'missing', input: 'x' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bad' },
      { id: 'e2', source: 'bad', target: 'good' },
    ],
  }
  const repaired = repairGeneratedFlowGraph(graph, { agents: [{ id: 'a1' }], toolCatalog: [] })
  assert.equal(repaired.nodes.some((node) => node.id === 'bad'), false)
  assert.equal(repaired.edges.some((edge) => edge.source === 'bad' || edge.target === 'bad'), false)
  assert.ok(repaired.edges.some((edge) => edge.source === 'trigger' && edge.target === 'good'))
})

test('repairGeneratedFlowGraph prunes unavailable tools and container references', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['keep', 'drop'] } },
      { id: 'keep', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{}' } },
      { id: 'drop', type: 'tool', data: { connectionId: 'c1', toolName: 'missing', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const repaired = repairGeneratedFlowGraph(graph, {
    agents: [],
    toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }],
  })
  const loop = repaired.nodes.find((node) => node.id === 'loop')
  assert.deepEqual(loop?.type === 'loop' ? loop.data.body : [], ['keep'])
  assert.equal(repaired.nodes.some((node) => node.id === 'drop'), false)
})

test('validationIssuesForModel formats concise repair feedback', () => {
  const result = validateFlowGraph({ nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] })
  assert.match(validationIssuesForModel(result), /NO_STEPS/)
  assert.match(validationIssuesForModel(result), /Add at least one step/)
})
