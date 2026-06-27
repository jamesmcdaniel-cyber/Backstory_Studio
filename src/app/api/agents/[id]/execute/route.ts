import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { composeInstructions } from '@/lib/skills/compose'

export const runtime = 'nodejs'
export const maxDuration = 300

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { input } = z.object({ input: z.string().optional() }).parse(await request.json())
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const skillIds = Array.isArray((agent.metadata as any)?.skills) ? (agent.metadata as any).skills : []
  const objectiveWithSkills = composeInstructions(agent.objective, skillIds)
  const runInput = input?.trim() || objectiveWithSkills

  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: runInput },
      trigger: { type: 'manual' },
      metadata: { title: (agent.metadata as any)?.title || agent.description },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })

  if (inlineExecution) {
    try {
      const result = await runAgentExecution({
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      })
      return { success: true, executionId: execution.id, result }
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      })
      throw new ApiError('Agent run failed', 500, 'RUN_FAILED')
    }
  } else {
    if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
    try {
      const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('execute-agent', {
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      }, { jobId: execution.id })
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() },
      })
      throw new ApiError('Unable to queue agent execution', 503, 'QUEUE_UNAVAILABLE')
    }
    return { success: true, executionId: execution.id, status: 'pending' }
  }
})
