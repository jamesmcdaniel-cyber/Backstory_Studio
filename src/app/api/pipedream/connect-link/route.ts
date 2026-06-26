import { z } from 'zod'
import { getPipedreamClient } from '@/lib/pipedream/client'
import { pipedreamApiError } from '@/lib/pipedream/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { appSlug } = z.object({ appSlug: z.string().min(1) }).parse(await request.json())
  const origin = request.nextUrl.origin
  try {
    const token = await getPipedreamClient().tokens.create({
      externalUserId: auth.dbUser.id,
      successRedirectUri: `${origin}/integrations?connected=${encodeURIComponent(appSlug)}`,
      errorRedirectUri: `${origin}/integrations?error=${encodeURIComponent(appSlug)}`,
      allowedOrigins: [origin],
    })
    return { success: true, url: token.connectLinkUrl }
  } catch (error) {
    throw pipedreamApiError(error)
  }
})
