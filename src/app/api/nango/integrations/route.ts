import { getNangoClient } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Lists the integrations enabled on the Nango environment. These are the
// apps a user can connect from the integrations page.
export const GET = withAuthenticatedApi(async () => {
  let configs
  try {
    ;({ configs } = await getNangoClient().listIntegrations())
  } catch (error) {
    throw nangoApiError(error)
  }

  const integrations = configs.map((config) => ({
    id: config.unique_key,
    provider: config.provider,
    name: config.display_name || config.provider,
    logo: config.logo,
  }))

  return { success: true, integrations }
})
