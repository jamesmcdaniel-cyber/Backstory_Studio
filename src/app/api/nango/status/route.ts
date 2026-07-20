import { nangoApiError } from '@/lib/nango/errors'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Lists the organization's Nango connections (live from Nango) and mirrors them
// into the per-org nango_connections table. Nango owns the credentials; we only
// persist connection ids and health. The mirror is also kept fresh by the Nango
// webhook (see /api/nango/webhook) so headless agent runs don't depend on this
// page being opened.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  try {
    const connections = await syncOrgNangoConnections(auth.organizationId)
    return { success: true, connections }
  } catch (error) {
    throw nangoApiError(error)
  }
})
