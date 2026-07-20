import { ApiError } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { qwenConfigured } from '@/lib/llm/qwen'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'

/**
 * Preflight for authenticated, interactive LLM endpoints (copilot generate/chat,
 * per-run Q&A chat, AI search). These call the model directly and so bypass the
 * agent-run budget path — this is where their spend is gated. Enforces, in order:
 *
 *   1. a model provider is configured (else 503 AI_UNAVAILABLE),
 *   2. the caller is under their per-minute rate limit (else 429 RATE_LIMITED),
 *   3. the workspace is under its monthly token ceiling (else 429 BUDGET_EXCEEDED).
 *
 * Throws ApiError on any gate — call it BEFORE spending any tokens. Pair with
 * recordEstimatedUsage after the call so repeated use actually trips the ceiling.
 */
export async function assertAiCallAllowed(opts: {
  organizationId: string
  /** Rate-limit bucket, typically `<feature>:<userId>`. */
  rateKey: string
  /** Max calls per window. */
  limit: number
  /** Window length; defaults to 60s. */
  windowMs?: number
}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const limited = await rateLimit(opts.rateKey, { limit: opts.limit, windowMs: opts.windowMs ?? 60_000 })
  if (!limited.ok) {
    throw new ApiError('You’re sending requests too quickly — give it a few seconds.', 429, 'RATE_LIMITED')
  }
  const budget = await checkMonthlyTokenBudget(opts.organizationId)
  if (budget.over) {
    throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')
  }
}

/**
 * Best-effort token metering for endpoints whose model helper returns no usage
 * counts. Estimates ~chars/4 across the given input+output strings and adds it
 * to the month-to-date counter so interactive LLM spend still counts toward the
 * ceiling. Never throws. (When the SDK returns real usage, record that instead.)
 */
export function recordEstimatedUsage(
  organizationId: string,
  ...parts: Array<string | null | undefined>
): void {
  const chars = parts.reduce((sum, part) => sum + (part ? part.length : 0), 0)
  if (chars <= 0) return
  void recordTokenUsage(organizationId, Math.ceil(chars / 4)).catch(() => undefined)
}
