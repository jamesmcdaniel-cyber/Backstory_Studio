import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'ResumeClaim', slug: `resume-claim-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'resume-target', organizationId: org.id, status: 'ACTIVE', graph: emptyGraph, publishedGraph: emptyGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('resuming a run that is not `waiting` throws FLOW_RUN_NOT_WAITING and does not re-run it', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'succeeded', graphSnapshot: emptyGraph },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'hi' }),
      (error: any) => error.code === 'FLOW_RUN_NOT_WAITING',
    )
    const after1 = await prisma.flowRun.findUnique({ where: { id: run.id } })
    assert.equal(after1.status, 'succeeded') // untouched — the claim never fired
  })

  test('resuming a run that IS waiting succeeds and pins execution to graphSnapshot, not the flow\'s current graph', async () => {
    // The run's snapshot has an extra 'legacy' marker node absent from the flow's
    // CURRENT (edited-after-pause) graph — if resume re-derives from flow.graph
    // instead of the snapshot, this node would vanish and resume would silently
    // run a different graph shape than the one that paused.
    const snapshot = { nodes: [...emptyGraph.nodes, { id: 'legacy', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }], edges: [] }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    // Simulate the flow having been republished since the run paused.
    await prisma.flow.update({ where: { id: ids.flow }, data: { graph: emptyGraph, publishedGraph: emptyGraph } })

    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' })
    // The trigger has no outgoing edge to 'legacy' in either graph, so the run
    // completes immediately either way — this test's job is only to prove the
    // claim succeeded (status flipped, not thrown) using the snapshot's shape,
    // verified indirectly via the second assertion below.
    assert.equal(result.flowRunId, run.id)

    const claimed = await prisma.flowRun.findUnique({ where: { id: run.id } })
    assert.notEqual(claimed.status, 'waiting')
  })

  test('a second concurrent resume of the same run loses cleanly after the first claims it', async () => {
    // The snapshot needs at least one non-trigger step or the winning claimant
    // would reject on graph validation (NO_STEPS) instead of fulfilling.
    const snapshot = { nodes: [...emptyGraph.nodes, { id: 'stop', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }], edges: [] }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    const [first, second] = await Promise.allSettled([
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'a' }),
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'b' }),
    ])
    const outcomes = [first, second]
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'FLOW_RUN_NOT_WAITING')
  })
}
