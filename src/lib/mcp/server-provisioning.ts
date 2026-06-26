import { prisma } from '@/lib/prisma'
import { KlavisClient, type KlavisServer } from './klavis-client'
import { PROVIDERS, PROVIDER_CAPABILITIES, type MCPProvider } from './provider-capabilities'

export type ConnectionStatus = 'pending_auth' | 'active' | 'error' | 'not_connected'

export type ServerCreationResult = {
  provider: MCPProvider
  instanceId: string
  serverUrl?: string
  oauthUrl?: string
  status: Exclude<ConnectionStatus, 'not_connected'>
}

function client() {
  if (!process.env.KLAVIS_API_KEY) throw new Error('KLAVIS_API_KEY is not configured')
  return new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sprintiq' })
}

function connectionStatus(server: KlavisServer): Exclude<ConnectionStatus, 'not_connected'> {
  return server.isAuthenticated ? 'active' : 'pending_auth'
}

async function saveConnection(
  provider: MCPProvider,
  userId: string,
  organizationId: string,
  server: KlavisServer,
) {
  const status = connectionStatus(server)
  const existing = await prisma.mCPAgent.findFirst({
    where: { userId, organizationId, agentType: provider.toUpperCase() },
  })
  const configuration = { provider, verbs: PROVIDER_CAPABILITIES[provider].verbs }
  const metadata = {
    instanceId: server.instanceId,
    oauthUrl: server.oauthUrl ?? null,
    status,
  }

  if (existing) {
    return prisma.mCPAgent.update({
      where: { id: existing.id },
      data: {
        ...(server.serverUrl ? { mcpServerUrl: server.serverUrl } : {}),
        isActive: status === 'active',
        configuration,
        metadata,
      },
    })
  }

  return prisma.mCPAgent.create({
    data: {
      mcpServerUrl: server.serverUrl ?? '',
      isActive: status === 'active',
      configuration,
      metadata,
      userId,
      organizationId,
      name: `${provider}_agent`,
      agentType: provider.toUpperCase(),
      description: PROVIDER_CAPABILITIES[provider].description,
    },
  })
}

export async function createServersForTenant(
  _tenantId: string,
  userId: string,
  organizationId: string,
  selectedProviders: MCPProvider[] = [...PROVIDERS],
): Promise<ServerCreationResult[]> {
  const klavis = client()
  const results: ServerCreationResult[] = []

  for (const provider of selectedProviders) {
    // Idempotent connect: reuse the existing Klavis instance for this provider
    // instead of creating a new one each click (the free tier caps instances).
    const existing = await prisma.mCPAgent.findFirst({
      where: { userId, organizationId, agentType: provider.toUpperCase() },
    })
    const existingInstanceId = (existing?.metadata as Record<string, any> | null)?.instanceId as string | undefined

    let server: KlavisServer | null = null
    if (existingInstanceId) {
      try {
        server = await klavis.getServerStatus(existingInstanceId)
        server.serverUrl = server.serverUrl ?? existing?.mcpServerUrl
      } catch {
        server = null // instance no longer exists on Klavis — recreate below
      }
    }
    if (!server) {
      server = await klavis.createServerInstance(provider, `${organizationId}:${userId}`)
    }

    await saveConnection(provider, userId, organizationId, server)
    results.push({
      provider,
      instanceId: server.instanceId,
      serverUrl: server.serverUrl,
      oauthUrl: server.oauthUrl,
      status: connectionStatus(server),
    })
  }

  return results
}

export async function getConnectionStatuses(organizationId: string, userId: string) {
  const connections = await prisma.mCPAgent.findMany({
    where: { organizationId, userId },
    orderBy: { updatedAt: 'desc' },
  })
  const klavis = process.env.KLAVIS_API_KEY ? client() : null
  const byProvider = new Map<string, {
    provider: MCPProvider
    status: ConnectionStatus
    oauthUrl?: string
    toolCount?: number
  }>()

  for (const connection of connections) {
    const provider = connection.agentType.toLowerCase() as MCPProvider
    if (!PROVIDERS.includes(provider)) continue
    const metadata = (connection.metadata as Record<string, any> | null) || {}
    let status = (metadata.status || (connection.isActive ? 'active' : 'pending_auth')) as ConnectionStatus
    let oauthUrl = metadata.oauthUrl as string | undefined
    let toolCount: number | undefined

    if (klavis && metadata.instanceId) {
      try {
        const server = await klavis.getServerStatus(metadata.instanceId)
        status = connectionStatus(server)
        oauthUrl = server.oauthUrl
        // The GET response omits serverUrl; reuse the one stored at create time.
        if (status === 'active' && connection.mcpServerUrl) {
          toolCount = (await klavis.getServerTools(connection.mcpServerUrl)).length
        }
        await saveConnection(provider, userId, organizationId, {
          ...server,
          serverUrl: server.serverUrl ?? connection.mcpServerUrl,
        })
      } catch {
        status = 'error'
      }
    }

    byProvider.set(provider, { provider, status, oauthUrl, toolCount })
  }

  return PROVIDERS.map((provider) => byProvider.get(provider) || { provider, status: 'not_connected' as const })
}

export async function removeServerConnection(organizationId: string, provider: MCPProvider, userId: string) {
  const connection = await prisma.mCPAgent.findFirst({
    where: { organizationId, userId, agentType: provider.toUpperCase() },
  })
  if (!connection) return
  const metadata = (connection.metadata as Record<string, any> | null) || {}

  if (process.env.KLAVIS_API_KEY && metadata.instanceId) {
    await client().deleteServerInstance(metadata.instanceId)
  }
  await prisma.mCPAgent.delete({ where: { id: connection.id } })
}
