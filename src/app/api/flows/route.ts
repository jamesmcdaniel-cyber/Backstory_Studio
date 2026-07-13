import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { serializeFlow } from '@/lib/flows/serialize'
import { normalizeFlowTrigger, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { assertFlowEditable } from '@/lib/flows/access'

// Strip undefined + narrow to plain JSON so Prisma's InputJsonValue accepts the
// zod-inferred shapes (passthrough trigger / discriminated-union graph).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const triggerSchema = z.object({ type: z.enum(['manual', 'schedule', 'webhook', 'signal']).default('manual') }).passthrough()
const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).default('DRAFT'),
  visibility: z.enum(['shared', 'private', 'view']).default('shared'),
  trigger: triggerSchema.optional(),
  graph: flowGraphSchema.optional(),
  folder: z.string().max(60).optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return { success: true, flows: flows.map((flow) => serializeFlow(flow, auth.dbUser.id)) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = flowSchema.parse(await request.json())
  const graph = data.graph ?? emptyGraph()
  const trigger = data.trigger ? normalizeFlowTrigger(data.trigger) : triggerFromGraph(graph)
  const flow = await prisma.flow.create({
    data: {
      name: data.name,
      description: data.description,
      status: data.status,
      visibility: data.visibility,
      folder: data.folder ?? '',
      trigger: jsonValue(trigger),
      graph: jsonValue(graph),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(flowSchema.partial()).parse(await request.json())
  const existing = await prisma.flow.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(existing, auth.dbUser.id)
  const nextTrigger =
    body.trigger !== undefined
      ? normalizeFlowTrigger(body.trigger)
      : body.graph !== undefined
        ? triggerFromGraph(body.graph, existing.trigger)
        : undefined
  const flow = await prisma.flow.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.folder !== undefined && { folder: body.folder }),
      // Preserve the webhook secret hash across trigger edits — the client
      // never sees it, so a plain PUT would silently wipe it.
      ...(nextTrigger !== undefined && { trigger: jsonValue(preserveWebhookSecretHash(nextTrigger, existing.trigger)) }),
      ...(body.graph !== undefined && { graph: jsonValue(body.graph) }),
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(existing, auth.dbUser.id)
  await prisma.flow.deleteMany({ where: { id, organizationId: auth.organizationId } })
  return { success: true }
})
