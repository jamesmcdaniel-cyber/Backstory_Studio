import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const scheduleSchema = z.object({
  type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron']).default('manual'),
  time: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().default('UTC'),
  isActive: z.boolean().default(false),
})

const agentSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  instructions: z.string().min(1),
  model: z.string().default('claude-opus-4-8'),
  priority: z.string().default('medium'),
  integrations: z.array(z.string()).default([]),
  folder: z.string().trim().max(60).nullish(),
  visibility: z.enum(['shared', 'private']).default('shared'),
  icon: z.string().trim().max(8).optional(),
  schedule: scheduleSchema.default({ type: 'manual', timezone: 'UTC', isActive: false }),
})

function serializeAgent(agent: any) {
  const metadata = agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}
  return {
    id: agent.id,
    title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
    description: metadata.description || agent.description,
    instructions: agent.objective,
    model: metadata.model || 'claude-opus-4-8',
    integrations: metadata.integrations || [],
    icon: metadata.icon || '🤖',
    folder: agent.folder || null,
    visibility: agent.visibility || 'shared',
    status: agent.status.toLowerCase(),
    priority: agent.priority.toLowerCase(),
    schedule: agent.schedule,
    createdAt: agent.createdAt,
    lastExecutedAt: agent.lastExecutedAt,
    executionCount: agent.executionCount,
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const agents = await prisma.agentTask.findMany({
    where: { organizationId: auth.organizationId, status: { not: 'DELETED' } },
    orderBy: { updatedAt: 'desc' },
  })
  return { success: true, agents: agents.map(serializeAgent) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = agentSchema.parse(await request.json())
  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent',
      agentType: 'CUSTOM',
      priority: data.priority.toUpperCase(),
      description: data.description || data.title,
      objective: data.instructions,
      context: {},
      schedule: data.schedule,
      status: 'ACTIVE',
      folder: data.folder || null,
      visibility: data.visibility,
      organizationId: auth.organizationId,
      metadata: {
        title: data.title,
        description: data.description,
        model: data.model,
        integrations: data.integrations,
        icon: data.icon || '🤖',
      },
    },
  })
  return { success: true, agent: serializeAgent(agent) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(agentSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTask.findFirst({ where: { id: body.id, organizationId: auth.organizationId } })
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {}
  const agent = await prisma.agentTask.update({
    where: { id: body.id },
    data: {
      ...(body.description !== undefined && { description: body.description || body.title || existing.description }),
      ...(body.instructions !== undefined && { objective: body.instructions }),
      ...(body.priority !== undefined && { priority: body.priority.toUpperCase() }),
      ...(body.schedule !== undefined && { schedule: body.schedule }),
      ...(body.folder !== undefined && { folder: body.folder || null }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      metadata: {
        ...metadata,
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.icon !== undefined && { icon: body.icon }),
      },
    },
  })
  return { success: true, agent: serializeAgent(agent) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTask.updateMany({
    where: { id, organizationId: auth.organizationId },
    data: { status: 'DELETED' },
  })
  if (!result.count) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return { success: true }
})
