import { getPipedreamClient } from '@/lib/pipedream/client'
import { pipedreamApiError } from '@/lib/pipedream/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request) => {
  const q = request.nextUrl.searchParams.get('q') || undefined
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100)
  let response
  try {
    response = await getPipedreamClient().apps.list({ q, limit })
  } catch (error) {
    throw pipedreamApiError(error)
  }
  const apps: Array<Record<string, unknown>> = []

  for await (const app of response) {
    apps.push({
      id: app.id,
      slug: (app as any).nameSlug,
      name: app.name,
      description: app.description,
      imgSrc: app.imgSrc,
      categories: app.categories,
      authType: app.authType,
    })
    if (apps.length >= limit) break
  }

  return { success: true, apps }
})
