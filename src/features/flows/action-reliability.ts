const DEFAULT_RETRY_DELAY_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Thrown by withTimeout so callers can tell a timeout from a hard failure. */
export class FlowTimeoutError extends Error {}

/**
 * Retry-after-TIMEOUT policy per step kind (hard errors always retry up to
 * `retries`). Agent, tool, and ai timeouts merely ABANDON the in-flight call —
 * Promise.race / withTimeout cannot cancel it — so the first execution may
 * still be running; retrying would spawn a second concurrent execution
 * (double token spend, duplicate side effects — same reasoning as tool: a
 * single-turn model call has no cancellation hook either). HTTP timeouts
 * abort the request itself (AbortController), so retrying them cannot stack
 * live work.
 */
export function shouldRetryAfterTimeout(kind: 'agent' | 'tool' | 'http' | 'ai' | 'subflow'): boolean {
  return kind === 'http'
}

export function flowActionRetries(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.round(value)))
    : 0
}

export function flowActionTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1000, Math.min(120000, Math.round(value)))
    : undefined
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined, timeoutMessage: string): Promise<T> {
  if (!timeoutMs) return operation
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FlowTimeoutError(timeoutMessage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number
    timeoutMs?: number
    timeoutMessage?: string
    retryDelayMs?: number
    // When false, a timeout is terminal: withTimeout only abandons the live
    // operation, so retrying could run it a second time concurrently. Hard
    // errors still retry. Defaults to true (existing behavior) — pass
    // shouldRetryAfterTimeout(kind) to apply the per-step-kind policy.
    retryOnTimeout?: boolean
  } = {},
): Promise<T> {
  const retries = flowActionRetries(options.retries)
  const timeoutMs = flowActionTimeoutMs(options.timeoutMs)
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(
        operation(attempt),
        timeoutMs,
        options.timeoutMessage ?? `Step timed out after ${timeoutMs}ms`,
      )
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      if (error instanceof FlowTimeoutError && options.retryOnTimeout === false) break
      await sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
