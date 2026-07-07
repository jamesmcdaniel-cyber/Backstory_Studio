import OpenAI from 'openai'

/**
 * OpenAI-compatible model provider — used for Qwen.
 *
 * Qwen speaks the OpenAI chat-completions wire format, so we reuse the OpenAI
 * SDK pointed at Qwen's endpoint rather than adding a second wire format. All
 * config comes from the environment (never hardcoded — the key is a secret):
 *
 *   QWEN_API_KEY   — bearer key for the Qwen endpoint
 *   QWEN_BASE_URL  — OpenAI-compatible base URL (e.g. https://…/v1)
 *   QWEN_MODEL     — exact model id the endpoint expects (overrides the UI id)
 *
 * ChatGPT/OpenAI models are no longer offered; this slot is Qwen-only.
 */

const TIMEOUT_MS = 120_000
const MAX_RETRIES = 1

/** True when the Qwen endpoint is fully configured (key + base URL). */
export function openAICompatConfigured(): boolean {
  return Boolean(process.env.QWEN_API_KEY && process.env.QWEN_BASE_URL)
}

/** An OpenAI SDK client pointed at the configured Qwen endpoint. */
export function openAICompatClient(): OpenAI {
  if (!openAICompatConfigured()) {
    throw new Error('Qwen is not configured — set QWEN_API_KEY and QWEN_BASE_URL')
  }
  return new OpenAI({
    apiKey: process.env.QWEN_API_KEY,
    baseURL: process.env.QWEN_BASE_URL,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })
}

/**
 * The exact model string to send to the endpoint. QWEN_MODEL (the id the
 * endpoint actually expects) overrides the UI-facing id when set.
 */
export function openAICompatModel(requested: string): string {
  return process.env.QWEN_MODEL?.trim() || requested
}
