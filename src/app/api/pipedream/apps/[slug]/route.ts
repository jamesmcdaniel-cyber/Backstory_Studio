import { getPipedreamClient } from '@/lib/pipedream/client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const slug = request.nextUrl.pathname.split('/').at(-1)
  if (!slug) throw new ApiError('App slug is required')

  const client = getPipedreamClient()
  const response = await client.accounts.list({ externalUserId: auth.dbUser.id })
  const matchingIds: string[] = []
  for await (const account of response) {
    const app = account?.app as { nameSlug?: string; slug?: string } | undefined
    const accountSlug = app?.nameSlug || app?.slug
    if (accountSlug === slug) matchingIds.push(account.id)
  }

  if (!matchingIds.length) throw new ApiError('Connected app not found', 404, 'NOT_FOUND')
  await Promise.all(matchingIds.map((id) => client.accounts.delete(id)))
  return { success: true }
})
