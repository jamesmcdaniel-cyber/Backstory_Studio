/**
 * Dead-letter capture for template-generation jobs — mirrors flow-dead-letter.ts
 * but deliberately terminalizes NOTHING.
 *
 * The flow/agent dead-letters are status-guarded: they only flip a run row to
 * `failed` when it is still in the exact state they own (`running`), so a
 * concurrent claim rollback or an already-settled run is never clobbered.
 * Template generation carries that discipline to its conclusion: the job has NO
 * mutable run/proposal state to own. `generateTemplateProposals` is purely
 * additive — it either writes a fresh batch of `open` proposals in one atomic
 * `createMany` or writes nothing; a failure leaves no partial row behind. So the
 * status-guarded set here is empty: we durably record the failure (DLQ +
 * Sentry) for inspection/re-run and touch no run or proposal state whatsoever.
 */

import type { Job } from 'bullmq'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { createQueue, QUEUE_NAMES } from './config'

export interface TemplateGenerationDeadLetterInput {
  queue: string
  jobId?: string
  organizationId?: string
  data: unknown
  error: string
}

export async function recordTemplateGenerationDeadLetter(
  input: TemplateGenerationDeadLetterInput,
): Promise<void> {
  // No run/proposal terminalization: a failed generation clobbers nothing (see
  // the file header) — we only make the failure durable + inspectable.
  try {
    const dlq = createQueue(QUEUE_NAMES.TEMPLATE_GENERATION_DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    apiLogger.error('failed to record template-generation dead letter', {
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  captureError(new Error(`template-generation job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    organizationId: input.organizationId,
  })
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromTemplateGenerationJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    void recordTemplateGenerationDeadLetter({
      queue: queueName,
      jobId: job.id,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}
