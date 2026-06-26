import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('claude-opus-4-8'),
})

function serializeTemplate(template: any) {
  const config = template.configuration && typeof template.configuration === 'object' ? template.configuration as any : {}
  return {
    id: template.id,
    name: template.name,
    description: template.description || '',
    category: template.type,
    instructions: config.instructions || template.description || '',
    integrations: config.integrations || [],
    tags: config.tags || [],
    model: config.model || 'claude-opus-4-8',
    custom: true,
  }
}

const builtInTemplates = [
  {
    id: 'weekly-report',
    name: 'Weekly report',
    description: 'Summarize important work and send a concise weekly update.',
    category: 'Reporting',
    instructions: 'Review activity from connected tools. Summarize accomplishments, blockers, decisions, and next steps.',
    integrations: ['slack', 'github', 'linear'],
    tags: ['recurring', 'summary'],
    model: 'claude-opus-4-8',
  },
  {
    id: 'support-triage',
    name: 'Support triage',
    description: 'Review incoming support issues and organize the next actions.',
    category: 'Operations',
    instructions: 'Review new support requests. Group duplicates, identify urgent issues, and propose owners and next actions.',
    integrations: ['zendesk', 'slack', 'linear'],
    tags: ['triage', 'support'],
    model: 'claude-opus-4-8',
  },
  {
    id: 'customer-research',
    name: 'Customer research',
    description: 'Collect account context and prepare a focused briefing.',
    category: 'Research',
    instructions: 'Research the requested account using connected tools. Return verified facts, open questions, and recommended next steps.',
    integrations: ['slack', 'github'],
    tags: ['research'],
    model: 'claude-opus-4-8',
  },
]

export const GET = withAuthenticatedApi(async (request, auth) => {
  const stored = await prisma.agentTemplate.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
  })
  const templates = [...builtInTemplates, ...stored.map(serializeTemplate)]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await prisma.agentTemplate.create({
    data: {
      name: data.name,
      description: data.description,
      type: data.category,
      configuration: {
        instructions: data.instructions,
        integrations: data.integrations,
        tags: data.tags,
        model: data.model,
      },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTemplate.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as any
  const template = await prisma.agentTemplate.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { type: body.category }),
      configuration: {
        ...config,
        ...(body.instructions !== undefined && { instructions: body.instructions }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.model !== undefined && { model: body.model }),
      },
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTemplate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  return { success: true }
})
