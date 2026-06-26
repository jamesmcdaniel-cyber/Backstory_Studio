import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

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

class AnthropicRunner implements ModelRunner {
  private readonly client: Anthropic

  constructor(readonly model: string) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured')
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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
      system,
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
      messages: transcript as Anthropic.MessageParam[],
    })
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
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
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

export function createModelRunner(model: string): ModelRunner {
  return model.startsWith('claude') ? new AnthropicRunner(model) : new OpenAIRunner(model)
}

// Cheap one-line summary for the activity feed. Best-effort: returns null
// when Anthropic is not configured or the call fails.
export async function generateHeadline(summary: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY || !summary.trim()) return null
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 64,
      system:
        'Summarize what an AI agent run accomplished in one short, friendly past-tense line of at most 10 words. Respond with the line only — no quotes, no preamble.',
      messages: [{ role: 'user', content: summary.slice(0, 4000) }],
    })
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    return text ? text.split('\n')[0].slice(0, 120) : null
  } catch {
    return null
  }
}
