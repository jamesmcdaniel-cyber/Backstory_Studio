import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { KlavisClient } from '@/lib/mcp/klavis-client'
import { notify } from '@/lib/notifications/service'
import {
  createModelRunner,
  generateHeadline,
  type ToolDefinition,
  type ToolResult,
} from '@/lib/llm/model-runner'

export type AgentExecutionJob = {
  executionId?: string
  agentId: string
  organizationId: string
  userId: string
  input?: string
  resume?: boolean
  reply?: string
}

type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  client: KlavisClient
}

type PendingQuestion = {
  toolCallId: string
  question: string
  stepId: string | null
  collectedResults: ToolResult[]
}

export const DEFAULT_AGENT_MODEL = 'claude-opus-4-8'

const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description:
    'Pause the run and ask the user one question. Call this only when you are blocked on a decision, missing information, or approval that only the user can provide. The run resumes when they reply.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
    },
    required: ['question'],
  },
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function toolName(provider: string, name: string) {
  return `${provider}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

async function loadTools(organizationId: string, providers: string[]) {
  if (!process.env.KLAVIS_API_KEY || providers.length === 0) {
    return { tools: [] as ToolDefinition[], bindings: new Map<string, ToolBinding>() }
  }

  const client = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sprintiq' })
  const agents = await prisma.mCPAgent.findMany({
    where: {
      organizationId,
      isActive: true,
      agentType: { in: providers.map((provider) => provider.toUpperCase()) },
    },
  })

  const tools: ToolDefinition[] = []
  const bindings = new Map<string, ToolBinding>()
  for (const agent of agents) {
    const provider = String(agent.agentType).toLowerCase()
    const available = await client.getServerTools(agent.mcpServerUrl)
    for (const tool of available.slice(0, 20)) {
      const name = toolName(provider, tool.name)
      if (bindings.has(name)) continue
      bindings.set(name, { provider, serverUrl: agent.mcpServerUrl, toolName: tool.name, client })
      tools.push({
        name,
        description: tool.description || `${tool.name} via ${provider}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      })
    }
  }
  return { tools: tools.slice(0, 64), bindings }
}

async function recordEvent(executionId: string, stepId: string | null, kind: string, payload?: unknown) {
  await prisma.workflowEvent.create({
    data: { executionId, stepId, kind, payload: jsonValue(payload) },
  })
}

export async function executeAgentJob(job: Job<AgentExecutionJob>) {
  const { agentId, organizationId, userId } = job.data
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new Error('Agent not found or inactive')

  const agentMetadata = metadataOf(agent.metadata)
  const model = agentMetadata.model || DEFAULT_AGENT_MODEL
  const runner = createModelRunner(model)

  const queuedExecution = job.data.executionId
    ? await prisma.agentExecution.findFirst({
        where: {
          id: job.data.executionId,
          agentTaskId: agentId,
          organizationId,
        },
      })
    : null
  if (job.data.executionId && !queuedExecution) throw new Error('Queued execution does not match this tenant and agent')

  const resuming = Boolean(job.data.resume)
  if (resuming && !queuedExecution) throw new Error('Resume requested without an execution')

  let transcript: unknown[]
  let pendingResults: ToolResult[] | null = null

  if (resuming && queuedExecution) {
    const executionMetadata = metadataOf(queuedExecution.metadata)
    const pending = executionMetadata.pendingQuestion as PendingQuestion | undefined
    if (queuedExecution.status !== 'waiting_for_input' || !pending || !Array.isArray(queuedExecution.transcript)) {
      throw new Error('Execution is not waiting for input')
    }
    transcript = queuedExecution.transcript as unknown[]
    const reply = job.data.reply?.trim() || 'The user did not provide an answer. Use your best judgment.'
    pendingResults = [
      ...(pending.collectedResults || []),
      { toolCallId: pending.toolCallId, content: reply },
    ]
    if (pending.stepId) {
      await prisma.workflowStep.update({
        where: { id: pending.stepId },
        data: { status: 'succeeded', output: jsonValue({ answer: reply }), completedAt: new Date() },
      })
    }
    await recordEvent(queuedExecution.id, pending.stepId || null, 'user.replied', { answer: reply })
  } else {
    transcript = runner.start(job.data.input || agent.objective)
  }

  const execution = queuedExecution
    ? await prisma.agentExecution.update({
        where: { id: queuedExecution.id },
        data: {
          status: 'running',
          model: runner.model,
          ...(resuming
            ? { metadata: jsonValue({ ...metadataOf(queuedExecution.metadata), pendingQuestion: null }) }
            : { startedAt: new Date() }),
        },
      })
    : await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'running',
          model: runner.model,
          input: { prompt: job.data.input || agent.objective },
          trigger: { type: 'schedule' },
          metadata: { title: agentMetadata.title || agent.description },
          userId,
          organizationId,
        },
      })

  if (!resuming) {
    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'user', content: job.data.input || agent.objective },
    })
  }

  const executionMetadata = metadataOf(execution.metadata)
  const segmentStart = Date.now()
  const usage = { inputTokens: 0, outputTokens: 0 }

  try {
    const providers = Array.isArray(agentMetadata.integrations) ? agentMetadata.integrations.map(String) : []
    const { tools, bindings } = await loadTools(organizationId, providers)
    const system = [
      'You are an autonomous agent working on behalf of a user. Follow these instructions:',
      agent.objective,
      'Use the connected tools when needed. If you are blocked on a decision, missing information, or approval that only the user can provide, call the ask_user tool and wait for the reply; for minor choices, use your best judgment and note it.',
      'When finished, report completed work, blockers, and errors factually. Only claim actions that are supported by tool results from this run.',
    ].join('\n')

    if (pendingResults) runner.appendToolResults(transcript, pendingResults)

    const maxTurns = Number(agentMetadata.maxTurns) || Number(process.env.AGENT_MAX_TURNS) || 16
    let finalText = ''

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const turnResult = await runner.next(transcript, system, [...tools, ASK_USER_TOOL])
      usage.inputTokens += turnResult.usage.inputTokens
      usage.outputTokens += turnResult.usage.outputTokens

      if (!turnResult.toolCalls.length) {
        finalText = turnResult.text || 'Agent completed without a text response.'
        break
      }

      const results: ToolResult[] = []
      let pendingAsk: { toolCallId: string; question: string } | null = null

      for (const call of turnResult.toolCalls) {
        if (call.name === ASK_USER_TOOL.name) {
          if (pendingAsk) {
            results.push({
              toolCallId: call.id,
              content: JSON.stringify({ error: 'Ask one question at a time. Fold this into your pending question.' }),
              isError: true,
            })
            continue
          }
          pendingAsk = {
            toolCallId: call.id,
            question: String(call.input.question || 'The agent needs your input to continue.'),
          }
          continue
        }

        const binding = bindings.get(call.name)
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: binding ? `${binding.provider}.${binding.toolName}` : call.name,
            status: 'running',
            input: jsonValue(call.input),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'tool.started', { name: step.node, args: call.input })

        try {
          if (!binding) throw new Error(`Tool binding not found: ${call.name}`)
          const result = await binding.client.executeTool(binding.serverUrl, binding.toolName, call.input)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.completed', { name: step.node })
          results.push({ toolCallId: call.id, content: JSON.stringify(result) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.failed', { name: step.node, error: message })
          results.push({ toolCallId: call.id, content: JSON.stringify({ error: message }), isError: true })
        }
      }

      if (pendingAsk) {
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: 'ask_user',
            status: 'waiting',
            input: jsonValue({ question: pendingAsk.question }),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'agent.question', { question: pendingAsk.question })
        await prisma.executionMessage.create({
          data: { executionId: execution.id, role: 'agent', content: pendingAsk.question },
        })
        await prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              pendingQuestion: {
                toolCallId: pendingAsk.toolCallId,
                question: pendingAsk.question,
                stepId: step.id,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_input',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs your input`,
          body: pendingAsk.question,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_input', question: pendingAsk.question }
      }

      runner.appendToolResults(transcript, results)
    }

    const summary = finalText || 'Agent reached the maximum number of tool-call turns.'
    const output = { summary }
    const headline = await generateHeadline(summary)

    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'agent', content: summary },
    })
    await prisma.$transaction([
      prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          output,
          transcript: jsonValue(transcript),
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          executionTime: { increment: Date.now() - segmentStart },
          completedAt: new Date(),
          metadata: jsonValue({ ...executionMetadata, pendingQuestion: null, ...(headline ? { headline } : {}) }),
        },
      }),
      prisma.agentTask.update({
        where: { id: agent.id },
        data: {
          lastExecutedAt: new Date(),
          executionCount: { increment: 1 },
          lastResult: output,
        },
      }),
    ])
    await notify({
      organizationId,
      userId,
      type: 'agent.completed',
      level: 'success',
      title: `${agentMetadata.title || agent.description} completed`,
      body: headline || summary,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    return output
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: 'failed',
        error: message,
        transcript: jsonValue(transcript),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
      },
    })
    await notify({
      organizationId,
      userId,
      type: 'agent.error',
      level: 'error',
      title: `${agentMetadata.title || agent.description} hit an error`,
      body: message,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    throw error
  }
}
