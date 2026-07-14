import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let startFlowExecution: any
  let runFlowExecution: any
  let flushDetachedFlowExecutions: any
  const ids: Record<string, string> = {}

  // trigger → stop: the smallest graph that validates and executes a step.
  const stopGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'stop', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } },
    ],
    edges: [{ id: 'e-stop', source: 'trigger', target: 'stop' }],
  }
  // A trigger with no steps fails graph validation (NO_STEPS).
  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ startFlowExecution, runFlowExecution, flushDetachedFlowExecutions } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'StartDurable', slug: `start-durable-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'start-target', organizationId: org.id, status: 'ACTIVE', graph: stopGraph, publishedGraph: stopGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('startFlowExecution creates the run row BEFORE execution finishes, and the detached run completes it', async () => {
    const started = await startFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: 'go' })
    assert.ok(started.flowRunId)
    assert.equal(started.status, 'running')

    // History exists immediately — this is what a navigating user comes back to.
    const row = await prisma.flowRun.findUnique({ where: { id: started.flowRunId, organizationId: ids.org } })
    assert.ok(row, 'the run row must exist as soon as startFlowExecution returns')
    assert.ok(row.graphSnapshot, 'the executed graph is pinned on the row up front')

    // The detached execution keeps going without the caller — settle it.
    await flushDetachedFlowExecutions()
    const settled = await prisma.flowRun.findUnique({ where: { id: started.flowRunId, organizationId: ids.org } })
    assert.equal(settled.status, 'succeeded')
    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: started.flowRunId } })
    assert.ok(steps.some((step) => step.nodeId === 'stop'), 'the stop step actually executed in the background')
  })

  test('a validation failure throws synchronously and never creates a run row', async () => {
    const invalid = await prisma.flow.create({
      data: { name: 'start-invalid', organizationId: ids.org, status: 'ACTIVE', graph: emptyGraph },
    })
    await assert.rejects(
      () => startFlowExecution({ flowId: invalid.id, organizationId: ids.org, userId: ids.user, input: '' }),
      (error: any) => error.code === 'FLOW_VALIDATION_ERROR',
    )
    const rows = await prisma.flowRun.count({ where: { flowId: invalid.id, organizationId: ids.org } })
    assert.equal(rows, 0)
  })

  test('runFlowExecution with preparedRunId adopts the pre-created row instead of creating a second one', async () => {
    const before1 = await prisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })
    const started = await startFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: 'go' })
    await flushDetachedFlowExecutions()
    const after1 = await prisma.flowRun.count({ where: { flowId: ids.flow, organizationId: ids.org } })
    assert.equal(after1, before1 + 1, 'exactly ONE row per started run — the worker must adopt, not re-create')
    const settled = await prisma.flowRun.findUnique({ where: { id: started.flowRunId, organizationId: ids.org } })
    assert.equal(settled.status, 'succeeded')
  })

  test('a stale/duplicate prepared delivery short-circuits on a settled run without re-executing', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'succeeded', graphSnapshot: stopGraph, output: { done: true } },
    })
    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, preparedRunId: run.id, input: 'go' })
    assert.equal(result.flowRunId, run.id)
    assert.equal(result.status, 'succeeded')
    const steps = await prisma.flowRunStep.count({ where: { flowRunId: run.id } })
    assert.equal(steps, 0, 'no step executed — the stored outcome was reported instead')
  })

  test('a prepared run whose graph no longer validates is terminalized failed, never orphaned running', async () => {
    // Snapshot references an agent that does not exist — validation throws on
    // the worker path AFTER the row exists.
    const badSnapshot = {
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
        { id: 'agent1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'deleted-agent-id', input: 'hi' } },
      ],
      edges: [{ id: 'e-agent', source: 'trigger', target: 'agent1' }],
    }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'running', graphSnapshot: badSnapshot, input: { prompt: '' } },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, preparedRunId: run.id, input: '' }),
      (error: any) => error.code === 'FLOW_VALIDATION_ERROR',
    )
    const settled = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(settled.status, 'failed')
    assert.ok(settled.error, 'the failure reason is persisted for the run panel')
  })
}
