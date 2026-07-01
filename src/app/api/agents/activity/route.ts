import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 200)
  const activities = await prisma.agentExecution.findMany({
    where: { organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
    omit: { transcript: true },
    orderBy: { startedAt: 'desc' },
    take: limit,
  })
  return { success: true, activities }
})
