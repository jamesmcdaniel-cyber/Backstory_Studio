import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertAgentAfter, deleteNode, updateNode } from '../mutate'
import { emptyGraph, type FlowGraph } from '../graph'

test('insertAgentAfter appends a node and links the trigger to it', () => {
  const { graph, nodeId } = insertAgentAfter(emptyGraph(), 'trigger', 'a1')
  assert.equal(graph.nodes.length, 2)
  assert.ok(graph.edges.some((e) => e.source === 'trigger' && e.target === nodeId))
})

test('insertAgentAfter splices between an existing pair, healing the chain', () => {
  // trigger -> n1 ; insert after trigger => trigger -> new -> n1
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const { graph, nodeId } = insertAgentAfter(base, 'trigger', 'a2')
  assert.ok(graph.edges.some((e) => e.source === 'trigger' && e.target === nodeId))
  assert.ok(graph.edges.some((e) => e.source === nodeId && e.target === 'n2')) // new -> old n1 (id n2)
})

test('deleteNode heals predecessor→successor and drops the node', () => {
  let g: FlowGraph = emptyGraph()
  g = insertAgentAfter(g, 'trigger', 'a1').graph // trigger -> n2
  const second = insertAgentAfter(g, g.nodes[1].id, 'a2') // n2 -> n3
  g = second.graph
  g = deleteNode(g, g.nodes[1].id) // delete the middle agent
  assert.equal(g.nodes.length, 2)
  assert.ok(g.edges.some((e) => e.source === 'trigger' && e.target === second.nodeId))
})

test('updateNode replaces the matching node', () => {
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const target = base.nodes[1]
  const updated = updateNode(base, { ...target, data: { agentId: 'CHANGED', input: 'x' } } as typeof target)
  const found = updated.nodes.find((n) => n.id === target.id)
  assert.equal(found?.type === 'agent' ? found.data.agentId : '', 'CHANGED')
})
