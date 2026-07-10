/**
 * BullMQ job options for a queued flow execution (see execute-flow.ts's
 * dispatchFlowExecution). Resume jobs get a jobId derived from the run —
 * redelivery/retry of the SAME job is safe because runFlowExecution's atomic
 * claim (Task 1 of WS-R2) makes a second attempt a harmless no-op. Fresh
 * executions get attempts:1 — there is no pre-existing row a retry could
 * safely resume against, so a retry would duplicate the whole run.
 */
export type FlowQueueDecision = { jobId?: string; attempts?: number }

export function flowJobOptions(flowRunId: string | undefined, now: number = Date.now()): FlowQueueDecision {
  if (flowRunId) return { jobId: `${flowRunId}-resume-${now}` }
  return { attempts: 1 }
}
