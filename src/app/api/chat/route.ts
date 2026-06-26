import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const SYSTEM_PROMPT =
  'Answer questions about an AI agent run. Be precise about its output, tool calls, and errors. Do not claim actions not present in the run data.'

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const { executionId, question } = z.object({
    executionId: z.string().min(1),
    question: z.string().min(1).max(4000),
  }).parse(await request.json())

  const execution = await prisma.agentExecution.findFirst({
    where: { id: executionId, organizationId: auth.organizationId },
    include: { workflowSteps: true, messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!execution) throw new ApiError('Execution not found', 404, 'NOT_FOUND')

  // The raw model transcript is large and internal; answer from the run record.
  const run = { ...execution, transcript: undefined }
  const prompt = JSON.stringify({ question, execution: run })

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
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

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  })
  return { success: true, answer: response.choices[0]?.message?.content || 'No answer returned.' }
})
