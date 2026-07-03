import { z } from 'zod'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { decideApproval } from '@/lib/agents/approval'

const schema = z.object({ decision: z.enum(['approve', 'reject']) })

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() || ''
  const { decision } = schema.parse(await request.json())
  try {
    const result = await decideApproval({
      approvalId: id,
      organizationId: auth.organizationId,
      deciderUserId: auth.dbUser.id,
      approve: decision === 'approve',
    })
    return { success: true, ...result }
  } catch (error) {
    if (error instanceof Error && error.message === 'Approval not found') {
      throw new ApiError('Approval not found', 404, 'NOT_FOUND')
    }
    throw error
  }
})
