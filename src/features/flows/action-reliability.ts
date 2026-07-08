const DEFAULT_RETRY_DELAY_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
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
      await sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
