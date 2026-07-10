/**
 * Dead-letter capture for flow jobs — mirrors dead-letter.ts but marks the
 * FlowRun row failed instead of an AgentExecution. A fresh-execution job's
 * data carries no flowRunId (runFlowExecution creates that row itself), so
 * recordFlowDeadLetter can only mark a run failed when it fails as a RESUME
 * (flowRunId present in job.data); a fresh-execution failure is dead-lettered
 * for inspection but has no run row to update.
 */

import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { createQueue, QUEUE_NAMES } from './config'

export interface FlowDeadLetterInput {
  queue: string
  jobId?: string
  flowRunId?: string
  organizationId?: string
  data: unknown
  error: string
}

export async function recordFlowDeadLetter(input: FlowDeadLetterInput): Promise<void> {
  if (input.flowRunId) {
    await prisma.flowRun
      .update({
        where: { id: input.flowRunId },
        data: { status: 'failed', error: input.error.slice(0, 300), finishedAt: new Date() },
      })
      .catch(() => undefined)
  }

  try {
    const dlq = createQueue(QUEUE_NAMES.FLOW_DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    apiLogger.error('failed to record flow dead letter', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  captureError(new Error(`flow job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    flowRunId: input.flowRunId,
    organizationId: input.organizationId,
  })
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromFlowJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    void recordFlowDeadLetter({
      queue: queueName,
      jobId: job.id,
      flowRunId: typeof data.flowRunId === 'string' ? data.flowRunId : undefined,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}
