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

  test('reapStuckFlowRuns never touches steps of a run that legitimately leaves running before the write', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    const racingRun = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, status: 'running', startedAt: stale },
    })
    const racingStep = await prisma.flowRunStep.create({
      data: { flowRunId: racingRun.id, nodeId: 'n2', status: 'running', startedAt: stale },
    })

    // racingRun IS a `running` candidate at read time — it enters runIds —
    // but the onAfterRead hook flips it to `waiting` (simulating a legitimate
    // approval pause) before the transaction's write executes. This is the
    // exact race the re-query step in reapStuckFlowRuns exists to handle.
    const reaped = await reapStuckFlowRuns(new Date(), async () => {
      await prisma.flowRun.update({ where: { id: racingRun.id }, data: { status: 'waiting' } })
    })
    assert.equal(reaped, 0) // racingRun diverted away before the transaction write

    const runAfter = await prisma.flowRun.findUnique({ where: { id: racingRun.id } })
    assert.equal(runAfter.status, 'waiting')

    const stepAfter = await prisma.flowRunStep.findUnique({ where: { id: racingStep.id } })
    assert.equal(stepAfter.status, 'running')
  })

  test('reapStuckFlowRuns is idempotent — second pass reaps nothing', async () => {
    assert.equal(await reapStuckFlowRuns(), 0)
  })
}
