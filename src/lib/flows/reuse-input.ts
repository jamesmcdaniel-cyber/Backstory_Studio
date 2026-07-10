/**
 * Input memory for flow runs: a flow keeps executing with the input from its
 * last successful run until the user edits the flow.
 */

/**
 * Whether a new run may reuse the last successful run's input. Reuse is
 * allowed only when the flow has NOT been edited since that run started.
 * `Flow.updatedAt` is the edit signal — every save/publish bumps it — so an
 * edited flow always demands fresh input instead of silently replaying a
 * payload that may no longer match the graph. Simple and conservative: a
 * cosmetic rename also blocks reuse, which only costs one explicit re-entry.
 */
export function shouldReuseInput(args: { flowUpdatedAt: Date; lastSuccessStartedAt: Date }): boolean {
  return args.flowUpdatedAt.getTime() <= args.lastSuccessStartedAt.getTime()
}

/** Unwrap the run payload stored on a FlowRun row — creation wraps it as { prompt }. */
export function storedRunInput(input: unknown): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, 'prompt')) {
    return (input as Record<string, unknown>).prompt
  }
  return input
}

/**
 * Text to prefill the builder's test-input box from a stored run input:
 * strings pass through as-is, structured payloads become pretty JSON (the
 * same shape parseFlowInput turns back into an object on Run).
 */
export function prefillTextFromRunInput(input: unknown): string {
  const value = storedRunInput(input)
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}
