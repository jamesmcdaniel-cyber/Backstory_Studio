import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getPipedreamClient } from '@/lib/pipedream/client'
import { pipedreamApiError } from '@/lib/pipedream/errors'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// Pipedream app slug -> canonical provider name. Pipedream owns the account
// credentials; we only mirror connection state.
const providerMap: Record<string, { provider: string }> = {
  github: { provider: 'GITHUB' },
  slack: { provider: 'SLACK' },
  linear: { provider: 'LINEAR' },
  asana: { provider: 'ASANA' },
  monday: { provider: 'MONDAY' },
  jira: { provider: 'JIRA' },
  figma: { provider: 'FIGMA' },
  trello: { provider: 'TRELLO' },
  clickup: { provider: 'CLICKUP' },
  zendesk: { provider: 'ZENDESK' },
  'google-drive': { provider: 'GOOGLE_DRIVE' },
  googledrive: { provider: 'GOOGLE_DRIVE' },
  drive: { provider: 'GOOGLE_DRIVE' },
}

function toDate(value: unknown) {
  return typeof value === 'string' || value instanceof Date ? new Date(value) : null
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  let response
  try {
    response = await getPipedreamClient().accounts.list({ externalUserId: auth.dbUser.id })
  } catch (error) {
    throw pipedreamApiError(error)
  }
  const integrations: Record<string, Record<string, unknown>> = {}

  for await (const account of response) {
    const app = account?.app as { id?: string; nameSlug?: string; slug?: string } | undefined
    const slug = app?.nameSlug || app?.slug
    if (!slug) continue

    const connected = !account.dead
    const lastSync = toDate(account.lastRefreshedAt ?? account.updatedAt ?? account.createdAt) ?? new Date()
    const error = typeof account.error === 'string' ? account.error : undefined
    integrations[slug] = {
      connected,
      lastSync,
      error,
      user: account.externalId ? { name: account.externalId } : undefined,
    }

    const mapped = providerMap[slug.toLowerCase()]
    if (!mapped) continue
    const existing = await prisma.integration.findFirst({
      where: { userId: auth.dbUser.id, provider: { equals: mapped.provider, mode: 'insensitive' } },
    })
    const metadata = {
      ...((existing?.metadata as Record<string, unknown> | null) || {}),
      pipedream: {
        accountId: account.id,
        appSlug: slug,
        appId: app?.id ?? null,
        healthy: account.healthy ?? null,
        dead: account.dead ?? null,
        error: account.error ?? null,
      },
    } satisfies Prisma.InputJsonObject
    const data = {
      expiresAt: toDate(account.expiresAt),
      lastSyncAt: lastSync,
      metadata,
      lastError: error ?? null,
      status: connected ? 'connected' : error ? 'error' : 'disabled',
      isActive: connected,
    }

    if (existing) {
      await prisma.integration.update({ where: { id: existing.id }, data })
    } else {
      await prisma.integration.create({
        data: {
          ...data,
          userId: auth.dbUser.id,
          organizationId: auth.organizationId,
          provider: mapped.provider,
        },
      })
    }
  }

  return { success: true, integrations }
})
