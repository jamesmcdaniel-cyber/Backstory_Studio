import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { openAICompatClient, openAICompatConfigured, openAICompatModel } from '@/lib/llm/openai-compat'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'

const SYSTEM_PROMPT =
  'Answer questions about an AI agent run. Be precise about its output, tool calls, and errors. Do not claim actions not present in the run data.'

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !openAICompatConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const { executionId, question } = z.object({
    executionId: z.string().min(1),
    question: z.string().min(1).max(4000),
  }).parse(await request.json())

  const execution = await prisma.agentExecution.findFirst({
    where: { id: executionId, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
    include: { workflowSteps: true, messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!execution) throw new ApiError('Execution not found', 404, 'NOT_FOUND')

  // The raw model transcript is large and internal; answer from the run record.
  const run = { ...execution, transcript: undefined }
  const prompt = JSON.stringify({ question, execution: run })

  // Prefer Qwen (OpenAI-compatible) when the summary model is non-Claude and
  // configured; otherwise fall back to Anthropic.
  if (openAICompatConfigured() && !DEFAULT_SUMMARY_MODEL.startsWith('claude')) {
    const client = openAICompatClient()
    const response = await client.chat.completions.create({
      model: openAICompatModel(DEFAULT_SUMMARY_MODEL),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    })
    return { success: true, answer: response.choices[0]?.message?.content || 'No answer returned.' }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })
    const answer = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    return { success: true, answer: answer || 'No answer returned.' }
  }

  // Last resort: Qwen even if SUMMARY_MODEL was a claude id (no Anthropic key).
  const client = openAICompatClient()
  const response = await client.chat.completions.create({
    model: openAICompatModel('qwen-3.7'),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  })
  return { success: true, answer: response.choices[0]?.message?.content || 'No answer returned.' }
})
