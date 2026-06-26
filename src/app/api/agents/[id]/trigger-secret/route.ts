import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// Returns the agent's webhook trigger secret, creating it on first call.
// Pass { rotate: true } to invalidate the old secret and mint a new one.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { rotate } = z.object({ rotate: z.boolean().default(false) })
    .parse(await request.json().catch(() => ({})))

  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' } },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const metadata = agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
    ? agent.metadata as Record<string, unknown>
    : {}
  let secret = typeof metadata.triggerSecret === 'string' ? metadata.triggerSecret : null

  if (!secret || rotate) {
    secret = randomBytes(24).toString('base64url')
    await prisma.agentTask.update({
      where: { id: agent.id },
      data: { metadata: { ...metadata, triggerSecret: secret } },
    })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return {
    success: true,
    secret,
    url: `${baseUrl}/api/agents/${agent.id}/trigger`,
    usage: 'POST with header "x-trigger-secret: <secret>" and optional JSON body {"input": "..."}',
  }
})
