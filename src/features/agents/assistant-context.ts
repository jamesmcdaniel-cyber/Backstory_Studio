import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { readAgentMetadata } from '@/lib/agents/metadata'

/**
 * Server-side context assembly for the agent-scoped assistant chat. Pulls the
 * agent's configuration plus its recent run history (with tool calls and the
 * latest failure's error detail) into a compact JSON blob the model can ground
 * its answers in. Long values are clipped so a big run output cannot blow the
 * prompt budget.
 */

const RECENT_RUN_LIMIT = 8

function clip(value: unknown, max = 1200): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

type ExecutionRow = {
  id: string
  status: string
  error: string | null
  output: unknown
  metadata: unknown
  startedAt: Date
  completedAt: Date | null
}

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

function summarizeRun(execution: ExecutionRow) {
  const metadata = metadataOf(execution.metadata)
  return {
    id: execution.id,
    status: execution.status,
    startedAt: execution.startedAt.toISOString(),
    completedAt: execution.completedAt ? execution.completedAt.toISOString() : null,
    headline: typeof metadata.headline === 'string' ? metadata.headline : null,
    error: clip(execution.error, 1500) || null,
    output: clip(execution.output, 2000) || null,
  }
}

export type AssistantContext = {
  agent: {
    id: string
    title: string
    description: string
    instructions: string
    model: string | null
    integrations: string[]
    skills: string[]
    schedule: unknown
    status: string
  }
  recentRuns: ReturnType<typeof summarizeRun>[]
  latestRun: (ReturnType<typeof summarizeRun> & { toolCalls: unknown[]; conversation: unknown[] }) | null
  latestFailedRun: (ReturnType<typeof summarizeRun> & { toolCalls: unknown[]; conversation: unknown[] }) | null
}

export async function buildAssistantContext(agent: AgentTask): Promise<AssistantContext> {
  const executions = await prisma.agentExecution.findMany({
    where: { agentTaskId: agent.id },
    omit: { transcript: true },
    orderBy: { startedAt: 'desc' },
    take: RECENT_RUN_LIMIT,
  })

  const latest = executions[0]
  const latestFailed = executions.find((execution) => execution.status === 'failed')
  const detailIds = [...new Set([latest?.id, latestFailed?.id].filter((id): id is string => Boolean(id)))]

  const [steps, messages] = detailIds.length
    ? await Promise.all([
        prisma.workflowStep.findMany({
          where: { executionId: { in: detailIds } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.executionMessage.findMany({
          where: { executionId: { in: detailIds } },
          orderBy: { createdAt: 'asc' },
        }),
      ])
    : [[], []]

  const detailFor = (execution: ExecutionRow) => ({
    ...summarizeRun(execution),
    toolCalls: steps
      .filter((step) => step.executionId === execution.id)
      .map((step) => ({
        tool: step.node,
        status: step.status,
        input: clip(step.input, 600) || null,
        output: clip(step.output, 800) || null,
        error: clip(step.error, 800) || null,
      })),
    conversation: messages
      .filter((message) => message.executionId === execution.id)
      .map((message) => ({ role: message.role, content: clip(message.content, 600) })),
  })

  const agentMetadata = readAgentMetadata(agent.metadata)

  return {
    agent: {
      id: agent.id,
      title: agentMetadata.title || agent.description.split('\n')[0] || 'Untitled agent',
      description: agentMetadata.description || agent.description,
      instructions: agent.objective,
      model: agentMetadata.model || null,
      integrations: agentMetadata.integrations || [],
      skills: agentMetadata.skills || [],
      schedule: agent.schedule,
      status: agent.status.toLowerCase(),
    },
    recentRuns: executions.map(summarizeRun),
    latestRun: latest ? detailFor(latest) : null,
    latestFailedRun: latestFailed ? detailFor(latestFailed) : null,
  }
}
