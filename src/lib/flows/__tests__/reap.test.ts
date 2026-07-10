import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

test('stuck-run cutoff is 30 minutes', async () => {
  const { STUCK_FLOW_RUN_TIMEOUT_MS } = await import('../reap')
  assert.equal(STUCK_FLOW_RUN_TIMEOUT_MS, 30 * 60 * 1000)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let reapStuckFlowRuns: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ reapStuckFlowRuns } = await import('../reap'))
    const org = await prisma.organization.create({ data: { name: 'Reap', slug: `reap-${Date.now()}` } })
    ids.org = org.id
    const flow = await prisma.flow.create({
      data: { name: 'reap-target', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const fresh = new Date(Date.now() - 5 * 60 * 1000)
    ids.staleRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: stale },
      })
    ).id
    ids.staleStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n1', status: 'running', startedAt: stale },
      })
    ).id
    ids.staleDoneStep = (
      await prisma.flowRunStep.create({
        data: { flowRunId: ids.staleRunning, nodeId: 'n0', status: 'succeeded', startedAt: stale },
      })
    ).id
    ids.freshRunning = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'running', startedAt: fresh },
      })
    ).id
    ids.staleWaiting = (
      await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, status: 'waiting', startedAt: stale },
      })
    ).id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('reapStuckFlowRuns fails only stale running runs and their live steps', async () => {
    const reaped = await reapStuckFlowRuns()
    assert.equal(reaped, 1)

    const staleRun = await prisma.flowRun.findUnique({ where: { id: ids.staleRunning } })
    assert.equal(staleRun.status, 'failed')
    assert.equal(staleRun.error, 'The run was interrupted and timed out.')
    assert.ok(staleRun.finishedAt)

    const staleStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleStep } })
    assert.equal(staleStep.status, 'failed')

    const doneStep = await prisma.flowRunStep.findUnique({ where: { id: ids.staleDoneStep } })
    assert.equal(doneStep.status, 'succeeded')

    const freshRun = await prisma.flowRun.findUnique({ where: { id: ids.freshRunning } })
    assert.equal(freshRun.status, 'running')

    const waitingRun = await prisma.flowRun.findUnique({ where: { id: ids.staleWaiting } })
    assert.equal(waitingRun.status, 'waiting')
  })

  test('reapStuckFlowRuns never touches steps of a run it did not itself reap', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const pausedRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'waiting', startedAt: stale },
    })
    const pausedStep = await prisma.flowRunStep.create({
      data: { flowRunId: pausedRun.id, nodeId: 'n2', status: 'waiting', startedAt: stale },
    })

    await reapStuckFlowRuns()

    const stepAfter = await prisma.flowRunStep.findUnique({ where: { id: pausedStep.id } })
    assert.equal(stepAfter.status, 'waiting')

    const runAfter = await prisma.flowRun.findUnique({ where: { id: pausedRun.id } })
    assert.equal(runAfter.status, 'waiting')
  })

  test('reapStuckFlowRuns is idempotent — second pass reaps nothing', async () => {
    assert.equal(await reapStuckFlowRuns(), 0)
  })
}
