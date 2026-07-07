import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runFlowExecution } from '@/features/flows/execute-flow'

// POST /api/flows/[id]/execute — run a flow manually. id is the path segment
// before "execute".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const body = await request.json().catch(() => ({}))
  const input = z.object({ input: z.string().optional() }).parse(body).input ?? ''
  const run = await runFlowExecution({ flowId: id, organizationId: auth.organizationId, userId: auth.dbUser.id, input })
  return { success: true, run }
})
