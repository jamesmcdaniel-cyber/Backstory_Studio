/**
 * Stuck flow-run recovery. Flows execute inline in serverless/dispatcher
 * processes (no BullMQ job wraps them yet), so a recycled process orphans the
 * FlowRun as `running` forever — and the scheduled-flow overlap guard then
 * skips every future tick for that flow. The cron dispatch tick calls
 * reapStuckFlowRuns() to fail anything running past the budget, mirroring the
 * agent-execution reaper.
 */

import { prisma } from '@/lib/prisma'

// Dispatch/execute routes cap at maxDuration 1200s; 30 min = budget + slack.
export const STUCK_FLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000

const STUCK_RUN_ERROR = 'The run was interrupted and timed out.'
const REAP_BATCH_LIMIT = 500

/** Fail runs stuck `running` past the cutoff (and their still-live steps). Returns the reaped count. */
export async function reapStuckFlowRuns(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_FLOW_RUN_TIMEOUT_MS)
  const stuck = await prisma.flowRun.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    select: { id: true },
    take: REAP_BATCH_LIMIT,
  })
  if (stuck.length === 0) return 0
  const runIds = stuck.map((run) => run.id)
  // Status re-checked in the updateMany so a run that legitimately finished
  // between the read and the write is left alone.
  const [reaped] = await prisma.$transaction([
    prisma.flowRun.updateMany({
      where: { id: { in: runIds }, status: 'running' },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    }),
    prisma.flowRunStep.updateMany({
      where: { flowRunId: { in: runIds }, status: { in: ['queued', 'running', 'waiting'] } },
      data: { status: 'failed', error: STUCK_RUN_ERROR, finishedAt: now },
    }),
  ])
  return reaped.count
}
