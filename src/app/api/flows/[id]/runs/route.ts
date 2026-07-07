import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// GET /api/flows/[id]/runs — recent runs + the latest run's per-step status,
// polled by the builder canvas for live status. id is the segment before "runs".
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const runs = await prisma.flowRun.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    include: {
      steps: { orderBy: { order: 'asc' }, select: { nodeId: true, status: true, order: true, error: true } },
    },
  })
  const latest = runs[0] ? { id: runs[0].id, status: runs[0].status, steps: runs[0].steps } : null
  return {
    success: true,
    runs: runs.map((run) => ({ id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt })),
    latest,
  }
})
