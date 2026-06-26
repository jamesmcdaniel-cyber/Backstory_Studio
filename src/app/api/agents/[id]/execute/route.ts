import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { input } = z.object({ input: z.string().min(1) }).parse(await request.json())
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: input },
      trigger: { type: 'manual' },
      metadata: { title: (agent.metadata as any)?.title || agent.description },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })

  try {
    const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
    await queue.add('execute-agent', {
      executionId: execution.id,
      agentId: agent.id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      input,
    }, { jobId: execution.id })
  } catch (error) {
    await prisma.agentExecution.update({
      where: { id: execution.id },
      data: { status: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date() },
    })
    throw new ApiError('Unable to queue agent execution', 503, 'QUEUE_UNAVAILABLE')
  }

  return { success: true, executionId: execution.id, status: 'pending' }
})
