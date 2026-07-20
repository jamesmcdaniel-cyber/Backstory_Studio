import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from './client'

export type NangoConnectionStatus = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
}

/**
 * List an organization's Nango connections (live from Nango) and mirror them
 * into the per-org `nango_connections` table, reconciling deletions. Nango owns
 * the credentials; the mirror stores only connection ids + health so the agent
 * runtime (resolveNangoConnection) can resolve a provider connection without a
 * live round-trip on every tool call.
 *
 * Shared by GET /api/nango/status (populates the mirror on page view) and the
 * Nango webhook (populates it on connection events) — so a headless/scheduled
 * agent run can resolve a freshly-connected account even before anyone reopens
 * the integrations page. Returns per-config-key status for the UI.
 */
export async function syncOrgNangoConnections(
  organizationId: string,
): Promise<Record<string, NangoConnectionStatus>> {
  const response = await getNangoClient().listConnections({
    tags: { [NANGO_ORG_TAG]: organizationId },
  })

  const connections: Record<string, NangoConnectionStatus> = {}
  const seen: string[] = []

  for (const connection of response.connections ?? []) {
    seen.push(connection.connection_id)
    const errors = connection.errors ?? []
    const connected = errors.length === 0
    const error = connected ? undefined : `Connection needs attention (${errors[0].type})`
    const endUser = connection.end_user
    const key = connection.provider_config_key

    const existing = connections[key]
    connections[key] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), connection.connection_id],
      provider: connection.provider,
      error: existing?.error ?? error,
      lastSync: connection.created,
    }

    const metadata = {
      nango: {
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        endUserId: endUser?.id ?? null,
        errors,
      },
    } satisfies Prisma.InputJsonObject

    await prisma.nangoConnection.upsert({
      where: {
        organizationId_connectionId: {
          organizationId,
          connectionId: connection.connection_id,
        },
      },
      update: {
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
      create: {
        organizationId,
        userId: endUser?.id ?? null,
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
    })
  }

  // Drop mirror rows for connections that no longer exist in Nango.
  await prisma.nangoConnection.deleteMany({
    where: { organizationId, connectionId: { notIn: seen } },
  })

  return connections
}
