import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { apiLogger } from '@/lib/logger'

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResult = {
  toolCallId: string
  content: string
  isError?: boolean
}

export type ModelTurn = {
  text: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
}

// The transcript is provider-native message JSON. It is persisted on the
// execution and replayed verbatim on resume, so thinking/tool_use blocks
// survive a pause round-trip unchanged.
export interface ModelRunner {
  readonly model: string
  start(input: string): unknown[]
  appendUserMessage(transcript: unknown[], content: string): void
  appendToolResults(transcript: unknown[], results: ToolResult[]): void
  next(transcript: unknown[], system: string, tools: ToolDefinition[]): Promise<ModelTurn>
}

const ADAPTIVE_THINKING_MODELS = /^claude-(opus-4-[678]|sonnet-4-6|fable-5|mythos-5)/

// Bound a single model call below the BullMQ job lock (300s, see
// queue/config.ts) so a hung/slow call can't outlive the lock and make a run
// both dead-letter (stalled) and complete. The SDK `timeout` only wraps the
// fetch (which resolves at response HEADERS for a stream), so it bounds
// non-streaming calls; STREAM_DEADLINE_MS is an explicit end-to-end cap passed
// as an AbortSignal to the streaming turn to bound the body read too.
const LLM_TIMEOUT_MS = 120_000
const LLM_MAX_RETRIES = 1
const STREAM_DEADLINE_MS = 240_000

const CACHE_CONTROL = { type: 'ephemeral' as const }

/**
 * Add a rolling prompt-cache breakpoint on the last message so the growing
 * transcript prefix is cached turn-over-turn (cache reads bill ~0.1x). Operates
 * on a COPY — the persisted transcript (replayed verbatim on resume, where the
 * API rejects modified blocks) is never mutated.
 */
function withRollingCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages
  const out = messages.slice()
  const i = out.length - 1
  const last = out[i]
  if (typeof last.content === 'string') {
    out[i] = { ...last, content: [{ type: 'text', text: last.content, cache_control: CACHE_CONTROL }] }
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice()
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL } as (typeof blocks)[number]
    out[i] = { ...last, content: blocks }
  }
  return out
}

class AnthropicRunner implements ModelRunner {
  private readonly client: Anthropic

  constructor(readonly model: string) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured')
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
  }

  start(input: string): unknown[] {
    return [{ role: 'user', content: input }]
  }

  appendUserMessage(transcript: unknown[], content: string) {
    transcript.push({ role: 'user', content })
  }

  appendToolResults(transcript: unknown[], results: ToolResult[]) {
    transcript.push({
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    })
  }

  async next(transcript: unknown[], system: string, tools: ToolDefinition[]): Promise<ModelTurn> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 32000,
      // Cache the stable prefix: a breakpoint on the system block caches tools +
      // system together (they precede messages in the cache prefix), so they
      // bill at ~0.1x on every repeat turn instead of full price each turn.
      system: [{ type: 'text', text: system, cache_control: CACHE_CONTROL }],
      ...(ADAPTIVE_THINKING_MODELS.test(this.model) ? { thinking: { type: 'adaptive' as const } } : {}),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
            })),
          }
        : {}),
      messages: withRollingCache(transcript as Anthropic.MessageParam[]),
    }, { signal: AbortSignal.timeout(STREAM_DEADLINE_MS) })
    const message = await stream.finalMessage()
    transcript.push({ role: 'assistant', content: message.content })

    return {
      text: message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim(),
      toolCalls: message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: (block.input || {}) as Record<string, unknown>,
        })),
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens || 0) +
          (message.usage.cache_read_input_tokens || 0),
        outputTokens: message.usage.output_tokens,
      },
    }
  }
}

class OpenAIRunner implements ModelRunner {
  private readonly client: OpenAI

  constructor(readonly model: string) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
  }

  start(input: string): unknown[] {
    return [{ role: 'user', content: input }]
  }

  appendUserMessage(transcript: unknown[], content: string) {
    transcript.push({ role: 'user', content })
  }

  appendToolResults(transcript: unknown[], results: ToolResult[]) {
    for (const result of results) {
      transcript.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
    }
  }

  async next(transcript: unknown[], system: string, tools: ToolDefinition[]): Promise<ModelTurn> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        ...(transcript as OpenAI.ChatCompletionMessageParam[]),
      ],
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    })
    const message = response.choices[0]?.message
    if (!message) throw new Error('Model returned no message')
    transcript.push(message)

    return {
      text: (message.content || '').trim(),
      toolCalls: (message.tool_calls || [])
        .filter((call) => call.type === 'function')
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}') as Record<string, unknown>,
        })),
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Default models. OpenAI is the default provider — override either via env.
// AGENT_MODEL drives agent runs; SUMMARY_MODEL drives cheap surfaces (headlines,
// run Q&A). Set a claude-* value (plus ANTHROPIC_API_KEY) to use Anthropic.
// ---------------------------------------------------------------------------
export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL?.trim() || 'gpt-4o'
export const DEFAULT_SUMMARY_MODEL = process.env.SUMMARY_MODEL?.trim() || 'gpt-4o-mini'
const FALLBACK_CLAUDE_MODEL = 'claude-opus-4-8'

const hasOpenAI = () => !!process.env.OPENAI_API_KEY
const hasAnthropic = () => !!process.env.ANTHROPIC_API_KEY
const isClaude = (model: string) => model.startsWith('claude')

/**
 * Build a runner for the requested model, falling back to whichever provider is
 * actually configured. This means an agent saved with a claude-* model still
 * runs when only OPENAI_API_KEY is set (and vice-versa) instead of hard-failing.
 */
export function createModelRunner(requested?: string): ModelRunner {
  const model = requested?.trim() || DEFAULT_AGENT_MODEL

  if (isClaude(model)) {
    if (hasAnthropic()) return new AnthropicRunner(model)
    if (hasOpenAI()) return new OpenAIRunner(DEFAULT_AGENT_MODEL)
  } else {
    if (hasOpenAI()) return new OpenAIRunner(model)
    if (hasAnthropic()) return new AnthropicRunner(FALLBACK_CLAUDE_MODEL)
  }
  throw new Error('No model provider configured — set OPENAI_API_KEY (or ANTHROPIC_API_KEY).')
}

// Resolve which provider/model to use for a cheap "summary" call, honoring
// SUMMARY_MODEL but falling back to whichever provider's key is present.
function summaryTarget(): { provider: 'openai' | 'anthropic'; model: string } | null {
  const wantsClaude = isClaude(DEFAULT_SUMMARY_MODEL)
  if (wantsClaude && hasAnthropic()) return { provider: 'anthropic', model: DEFAULT_SUMMARY_MODEL }
  if (!wantsClaude && hasOpenAI()) return { provider: 'openai', model: DEFAULT_SUMMARY_MODEL }
  if (hasOpenAI()) return { provider: 'openai', model: 'gpt-4o-mini' }
  if (hasAnthropic()) return { provider: 'anthropic', model: 'claude-haiku-4-5' }
  return null
}

// Cheap one-line summary for the activity feed. Best-effort: returns null when
// no provider is configured or the call fails.
export async function generateHeadline(summary: string): Promise<string | null> {
  const target = summaryTarget()
  if (!target || !summary.trim()) return null
  const system =
    'Summarize what an AI agent run accomplished in one short, friendly past-tense line of at most 10 words. Respond with the line only — no quotes, no preamble.'
  try {
    let text = ''
    if (target.provider === 'anthropic') {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
      const response = await client.messages.create({
        model: target.model,
        max_tokens: 64,
        system,
        messages: [{ role: 'user', content: summary.slice(0, 4000) }],
      })
      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .trim()
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
      const response = await client.chat.completions.create({
        model: target.model,
        max_tokens: 64,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: summary.slice(0, 4000) },
        ],
      })
      text = (response.choices[0]?.message?.content || '').trim()
    }
    return text ? text.split('\n')[0].slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * One-shot structured-output completion against a JSON schema, used by the
 * natural-language agent builder and the assistant chat. Tries the preferred
 * provider first and FALLS BACK to the other on availability failures (quota,
 * auth, overload) — a dead key on one provider must not take the feature down
 * when the other works. Throws only when every configured provider failed or
 * none is configured. Returns the raw JSON string (caller parses).
 */
type StructuredOpts = {
  system: string
  user: string
  schema: Record<string, unknown>
  schemaName: string
  maxTokens?: number
}

/**
 * Availability failures (retryable on the OTHER provider): quota/rate limits,
 * bad or revoked keys, and provider-side outages. Schema/validation errors are
 * ours — retrying elsewhere won't help, so they propagate immediately.
 */
export function isProviderAvailabilityError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (typeof status !== 'number') return false
  return status === 401 || status === 403 || status === 429 || status >= 500
}

/** Provider order for structured calls: honor the default model's provider, try the other second. */
export function structuredProviderOrder(input: {
  defaultModel: string
  openai: boolean
  anthropic: boolean
}): Array<'openai' | 'anthropic'> {
  const wantsClaude = input.defaultModel.startsWith('claude')
  const order: Array<'openai' | 'anthropic'> = wantsClaude
    ? ['anthropic', 'openai']
    : ['openai', 'anthropic']
  return order.filter((provider) => (provider === 'openai' ? input.openai : input.anthropic))
}

async function anthropicStructured(opts: StructuredOpts): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
  const model = isClaude(DEFAULT_AGENT_MODEL) ? DEFAULT_AGENT_MODEL : FALLBACK_CLAUDE_MODEL
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: { type: 'json_schema', schema: opts.schema } },
  })
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

async function openaiStructured(opts: StructuredOpts): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
  const response = await client.chat.completions.create({
    model: isClaude(DEFAULT_AGENT_MODEL) ? 'gpt-4o' : DEFAULT_AGENT_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
    },
  })
  return response.choices[0]?.message?.content || ''
}

export async function generateStructured(opts: StructuredOpts): Promise<string> {
  const order = structuredProviderOrder({
    defaultModel: DEFAULT_AGENT_MODEL,
    openai: hasOpenAI(),
    anthropic: hasAnthropic(),
  })
  if (order.length === 0) {
    throw new Error('No model provider configured — set OPENAI_API_KEY (or ANTHROPIC_API_KEY).')
  }

  let lastError: unknown
  for (const provider of order) {
    try {
      return provider === 'anthropic' ? await anthropicStructured(opts) : await openaiStructured(opts)
    } catch (error) {
      lastError = error
      if (!isProviderAvailabilityError(error)) throw error
      apiLogger.warn('generateStructured: provider unavailable, trying fallback', {
        provider,
        status: (error as { status?: number }).status,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      })
    }
  }
  throw lastError
}
