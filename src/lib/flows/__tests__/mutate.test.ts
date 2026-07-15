import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  insertAgentAfter,
  insertNodeAfter,
  appendToBranch,
  duplicateNode,
  deleteNode,
  updateNode,
  addContainerStep,
  moveNodeAfter,
  moveContainerStep,
  sanitizeCopiedNode,
  pasteNodeAfter,
  addEdge,
  removeEdge,
  setNodePositions,
} from '../mutate'
import { emptyGraph, type FlowGraph, type FlowNode } from '../graph'

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

test('insertNodeAfter creates typed steps (http, tool, stop)', () => {
  const a = insertNodeAfter(emptyGraph(), 'trigger', 'http')
  const httpNode = a.graph.nodes.find((n) => n.id === a.nodeId)
  assert.equal(httpNode?.type, 'http')
  const b = insertNodeAfter(a.graph, a.nodeId, 'tool')
  assert.equal(b.graph.nodes.find((n) => n.id === b.nodeId)?.type, 'tool')
})

test('insertNodeAfter creates an ai step defaulted to the ask op', () => {
  const { graph, nodeId } = insertNodeAfter(emptyGraph(), 'trigger', 'ai')
  const node = graph.nodes.find((n) => n.id === nodeId)
  assert.equal(node?.type, 'ai')
  assert.deepEqual(node?.type === 'ai' ? node.data : null, { aiOp: 'ask', input: '', instructions: '' })
})

test('appendToBranch wires the first node of an empty false branch', () => {
  let g = insertNodeAfter(emptyGraph(), 'trigger', 'condition').graph
  const condId = g.nodes.find((n) => n.type === 'condition')!.id
  const res = appendToBranch(g, condId, 'false', 'agent', 'a1')
  g = res.graph
  const edge = g.edges.find((e) => e.source === condId && e.branch === 'false')
  assert.equal(edge?.target, res.nodeId)
  // appending again goes to the tail, not a second branch head
  const res2 = appendToBranch(g, condId, 'false', 'stop')
  assert.ok(res2.graph.edges.some((e) => e.source === res.nodeId && e.target === res2.nodeId))
})

test('addContainerStep creates typed loop body steps', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'loop').graph
  const loop = base.nodes.find((node) => node.type === 'loop')!
  const { graph, nodeId } = addContainerStep(base, loop.id, 'tool')
  const added = graph.nodes.find((node) => node.id === nodeId)
  const updatedLoop = graph.nodes.find((node) => node.id === loop.id)
  assert.equal(added?.type, 'tool')
  assert.ok(updatedLoop?.type === 'loop' && updatedLoop.data.body.includes(nodeId))
})

test('addContainerStep creates typed parallel branches', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'parallel').graph
  const parallel = base.nodes.find((node) => node.type === 'parallel')!
  const { graph, nodeId } = addContainerStep(base, parallel.id, 'http')
  const added = graph.nodes.find((node) => node.id === nodeId)
  const updatedParallel = graph.nodes.find((node) => node.id === parallel.id)
  assert.equal(added?.type, 'http')
  assert.ok(updatedParallel?.type === 'parallel' && updatedParallel.data.branches.some((branch) => branch[0] === nodeId))
})

test('deleteNode preserves the branch flag when healing a branch head', () => {
  let g = insertNodeAfter(emptyGraph(), 'trigger', 'condition').graph
  const condId = g.nodes.find((n) => n.type === 'condition')!.id
  const first = appendToBranch(g, condId, 'true', 'agent', 'a1')
  g = first.graph
  const second = appendToBranch(g, condId, 'true', 'agent', 'a2')
  g = second.graph
  g = deleteNode(g, first.nodeId) // delete the branch head
  const healed = g.edges.find((e) => e.source === condId && e.branch === 'true')
  assert.equal(healed?.target, second.nodeId)
})

test('duplicateNode copies a step right after the original', () => {
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const orig = base.nodes.find((n) => n.type === 'agent')!
  const { graph, nodeId } = duplicateNode(base, orig.id)
  const copy = graph.nodes.find((n) => n.id === nodeId)
  assert.equal(copy?.type, 'agent')
  assert.ok(graph.edges.some((e) => e.source === orig.id && e.target === nodeId))
})

test('updateNode replaces the matching node', () => {
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const target = base.nodes[1]
  const updated = updateNode(base, { ...target, data: { agentId: 'CHANGED', input: 'x' } } as typeof target)
  const found = updated.nodes.find((n) => n.id === target.id)
  assert.equal(found?.type === 'agent' ? found.data.agentId : '', 'CHANGED')
})

test('moveNodeAfter relocates a middle node to the chain tail', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph        // n2? ids depend on builder — capture them
  const a = g.nodes.find((n) => n.type === 'http')!.id
  g = insertNodeAfter(g, a, 'transform').graph
  const b = g.nodes.find((n) => n.type === 'transform')!.id
  g = insertNodeAfter(g, b, 'stop').graph
  const c = g.nodes.find((n) => n.type === 'stop')!.id
  const moved = moveNodeAfter(g, a, c)
  // chain is trigger -> b -> c -> a
  const next = (id: string) => moved.edges.find((e) => e.source === id && !e.branch)?.target
  assert.equal(next('trigger'), b)
  assert.equal(next(b), c)
  assert.equal(next(c), a)
  assert.equal(next(a), undefined)
  assert.equal(moved.nodes.length, g.nodes.length)
})

test('moveNodeAfter no-ops for trigger, same id, missing ids, and own-subtree drops', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = g.nodes.find((n) => n.type === 'loop')!
  const bodyId = (loop.data as { body: string[] }).body[0]
  assert.equal(moveNodeAfter(g, 'trigger', bodyId), g)
  assert.equal(moveNodeAfter(g, loop.id, loop.id), g)
  assert.equal(moveNodeAfter(g, 'nope', loop.id), g)
  assert.equal(moveNodeAfter(g, loop.id, bodyId), g) // can't drop a container into itself
  assert.equal(moveNodeAfter(g, bodyId, 'trigger'), g) // body steps use the array variant
})

test('moveNodeAfter no-ops for condition and switch nodes', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const a = g.nodes.find((n) => n.type === 'http')!.id
  g = insertNodeAfter(g, a, 'condition').graph
  const cond = g.nodes.find((n) => n.type === 'condition')!.id
  g = appendToBranch(g, cond, 'true', 'stop').graph
  const stop = g.nodes.find((n) => n.type === 'stop')!.id
  assert.equal(moveNodeAfter(g, cond, stop), g)
  assert.equal(moveNodeAfter(g, cond, a), g)
})

test('moveNodeAfter blocks drops into deep subtrees (nested containers and branch chains)', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const outer = g.nodes.find((n) => n.type === 'loop')!.id
  g = addContainerStep(g, outer, 'loop').graph
  const inner = (g.nodes.find((n) => n.id === outer) as Extract<FlowNode, { type: 'loop' }>).data.body.find((id) => {
    const n = g.nodes.find((x) => x.id === id)
    return n?.type === 'loop'
  })!
  const innerBody = (g.nodes.find((n) => n.id === inner) as Extract<FlowNode, { type: 'loop' }>).data.body[0]
  assert.ok(innerBody)
  assert.equal(moveNodeAfter(g, outer, innerBody), g)
})

test('moveContainerStep reorders a loop body', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = () => g.nodes.find((n) => n.type === 'loop')! as Extract<FlowNode, { type: 'loop' }>
  g = addContainerStep(g, loop().id, 'transform').graph
  g = addContainerStep(g, loop().id, 'stop').graph
  const before = loop().data.body
  const after = moveContainerStep(g, loop().id, 0, 2)
  const reordered = (after.nodes.find((n) => n.type === 'loop') as Extract<FlowNode, { type: 'loop' }>).data.body
  assert.deepEqual(reordered, [before[1], before[2], before[0]])
  assert.equal(moveContainerStep(g, loop().id, 0, 99), g)
})

test('sanitizeCopiedNode accepts steps, rejects triggers and garbage, empties containers', () => {
  const http = { id: 'x1', type: 'http', data: { method: 'GET', url: 'https://a.test' } }
  const ok = sanitizeCopiedNode(http)
  assert.equal(ok?.type, 'http')
  assert.equal(sanitizeCopiedNode({ id: 't', type: 'trigger', data: {} }), null)
  assert.equal(sanitizeCopiedNode('garbage'), null)
  const loop = sanitizeCopiedNode({ id: 'l', type: 'loop', data: { over: '{{trigger.input}}', body: ['zombie'] } })
  assert.deepEqual((loop as Extract<FlowNode, { type: 'loop' }>).data.body, [])
})

test('pasteNodeAfter splices a fresh-id copy into the chain', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'http').graph
  const a = g.nodes.find((n) => n.type === 'http')!.id
  const copied = sanitizeCopiedNode({ id: 'zzz', type: 'stop', data: { reason: 'done' } })!
  const { graph: pasted, nodeId } = pasteNodeAfter(g, a, copied)
  assert.notEqual(nodeId, 'zzz')
  const next = (id: string) => pasted.edges.find((e) => e.source === id && !e.branch)?.target
  assert.equal(next(a), nodeId)
  const node = pasted.nodes.find((n) => n.id === nodeId)!
  assert.equal(node.type, 'stop')
  assert.equal((node.data as { reason?: string }).reason, 'done')
})

test('pasteNodeAfter targets a loop-body step by inserting into the body list', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = g.nodes.find((n) => n.type === 'loop') as Extract<FlowNode, { type: 'loop' }>
  const bodyId = loop.data.body[0]
  const copied = sanitizeCopiedNode({ id: 'z', type: 'stop', data: { reason: 'done' } })!
  const { graph: pasted, nodeId } = pasteNodeAfter(g, bodyId, copied)
  const after = pasted.nodes.find((n) => n.id === loop.id) as Extract<FlowNode, { type: 'loop' }>
  assert.deepEqual(after.data.body, [bodyId, nodeId])
  assert.equal(pasted.edges.some((e) => e.source === bodyId || e.target === nodeId), false)
})

test('duplicateNode inside a loop body inserts the copy into the body list', () => {
  let g = emptyGraph()
  g = insertNodeAfter(g, 'trigger', 'loop').graph
  const loop = g.nodes.find((n) => n.type === 'loop') as Extract<FlowNode, { type: 'loop' }>
  const bodyId = loop.data.body[0]
  const { graph: duped, nodeId } = duplicateNode(g, bodyId)
  const after = duped.nodes.find((n) => n.id === loop.id) as Extract<FlowNode, { type: 'loop' }>
  assert.deepEqual(after.data.body, [bodyId, nodeId])
  assert.equal(duped.edges.some((e) => e.source === bodyId), false)
})

test('addEdge connects two nodes (fan-in) and rejects self/dup/cycle', () => {
  const base: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'b', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'j', type: 'agent', data: { agentId: 'x', input: 'y' } },
    ],
    edges: [
      { id: 'trigger->a', source: 'trigger', target: 'a' },
      { id: 'trigger->b', source: 'trigger', target: 'b' },
      { id: 'a->j', source: 'a', target: 'j' },
    ],
  }
  // Add a second parent into j (fan-in) — allowed.
  const added = addEdge(base, 'b', 'j')
  assert.equal(added.added, true)
  assert.equal(added.graph.edges.filter((e) => e.target === 'j').length, 2)
  // Self-edge rejected.
  assert.equal(addEdge(base, 'a', 'a').added, false)
  // Duplicate rejected.
  assert.equal(addEdge(added.graph, 'b', 'j').added, false)
  // Trigger as target rejected.
  assert.equal(addEdge(base, 'a', 'trigger').added, false)
  // Cycle rejected: j -> a would loop (a -> j already exists).
  assert.equal(addEdge(base, 'j', 'a').added, false)
})

test('removeEdge drops the edge by id', () => {
  const g: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } }],
    edges: [{ id: 'trigger->a', source: 'trigger', target: 'a' }],
  }
  assert.equal(removeEdge(g, 'trigger->a').edges.length, 0)
})

test('setNodePositions writes positions and leaves absent nodes untouched', () => {
  const g: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } }],
    edges: [],
  }
  const out = setNodePositions(g, new Map([['a', { x: 5, y: 6 }]]))
  assert.deepEqual(out.nodes.find((n) => n.id === 'a')!.position, { x: 5, y: 6 })
  assert.equal(out.nodes.find((n) => n.id === 'trigger')!.position, undefined)
})

test('deleteNode heals a linear 1-in-1-out node but only drops edges for a fan-in node', () => {
  // Linear: trigger -> a -> b -> c; delete b heals trigger... a -> c.
  const linear: FlowGraph = {
    nodes: ['trigger', 'a', 'b', 'c'].map((id) => (id === 'trigger' ? { id, type: 'trigger', data: {} } : { id, type: 'agent', data: { agentId: 'x', input: 'y' } })) as FlowGraph['nodes'],
    edges: [
      { id: 't->a', source: 'trigger', target: 'a' },
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'b->c', source: 'b', target: 'c' },
    ],
  }
  const healed = deleteNode(linear, 'b')
  assert.ok(healed.edges.some((e) => e.source === 'a' && e.target === 'c'), 'a reconnects to c')
  assert.ok(!healed.nodes.some((n) => n.id === 'b'))

  // Fan-in: p1,p2 -> j -> c; delete j drops its edges, NO guessed reconnection.
  const fanIn: FlowGraph = {
    nodes: ['trigger', 'p1', 'p2', 'j', 'c'].map((id) => (id === 'trigger' ? { id, type: 'trigger', data: {} } : { id, type: 'agent', data: { agentId: 'x', input: 'y' } })) as FlowGraph['nodes'],
    edges: [
      { id: 't->p1', source: 'trigger', target: 'p1' },
      { id: 't->p2', source: 'trigger', target: 'p2' },
      { id: 'p1->j', source: 'p1', target: 'j' },
      { id: 'p2->j', source: 'p2', target: 'j' },
      { id: 'j->c', source: 'j', target: 'c' },
    ],
  }
  const dropped = deleteNode(fanIn, 'j')
  assert.ok(!dropped.nodes.some((n) => n.id === 'j'))
  assert.equal(dropped.edges.filter((e) => e.source === 'j' || e.target === 'j').length, 0)
  // No cross-wiring invented between p1/p2 and c.
  assert.ok(!dropped.edges.some((e) => (e.source === 'p1' || e.source === 'p2') && e.target === 'c'))
})
