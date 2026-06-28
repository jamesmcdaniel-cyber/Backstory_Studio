import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  buildAuthConfig,
  mergeAuthConfig,
  redactConfig,
} from '@/lib/crypto/secrets'

// ── Zod schema ───────────────────────────────────────────────────────────

const mcpConnectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  serverUrl: z.string().url(),
  authType: z.enum(['none', 'api_key', 'oauth2']).default('none'),
  // api_key fields
  apiKey: z.string().optional(),
  headerName: z.string().optional(),
  // oauth2 fields
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.string().optional(),
  // common
  isActive: z.boolean().optional(),
})

// ── Serialiser (redacts secrets) ─────────────────────────────────────────

function serializeConnection(conn: {
  id: string
  organizationId: string
  name: string
  description: string | null
  serverUrl: string
  authType: string
  authConfig: unknown
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: conn.id,
    organizationId: conn.organizationId,
    name: conn.name,
    description: conn.description,
    serverUrl: conn.serverUrl,
    isActive: conn.isActive,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    auth: redactConfig(conn.authType, conn.authConfig),
  }
}

// ── GET — list org's connections ─────────────────────────────────────────

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    connections: connections.map(serializeConnection),
  }
})

// ── POST — create a connection ────────────────────────────────────────────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = mcpConnectionSchema.parse(await request.json())

  const authConfig = buildAuthConfig({
    authType: data.authType,
    apiKey: data.apiKey,
    headerName: data.headerName,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    tokenUrl: data.tokenUrl,
    scopes: data.scopes,
  })

  const connection = await prisma.mcpConnection.create({
    data: {
      organizationId: auth.organizationId,
      name: data.name,
      description: data.description ?? null,
      serverUrl: data.serverUrl,
      authType: data.authType,
      authConfig: authConfig as Prisma.InputJsonValue,
      isActive: data.isActive ?? true,
    },
  })

  return { success: true, connection: serializeConnection(connection) }
})

// ── PUT — update a connection ─────────────────────────────────────────────

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ id: z.string().min(1) })
    .merge(mcpConnectionSchema.partial())
    .parse(await request.json())

  const existing = await prisma.mcpConnection.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')

  // Merge authConfig: preserve secrets not provided in this update
  const existingConfig =
    existing.authConfig &&
    typeof existing.authConfig === 'object' &&
    !Array.isArray(existing.authConfig)
      ? (existing.authConfig as Record<string, unknown>)
      : {}

  const newAuthType = body.authType ?? existing.authType
  const authConfig = mergeAuthConfig(existingConfig, {
    authType: newAuthType as 'none' | 'api_key' | 'oauth2',
    apiKey: body.apiKey,
    headerName: body.headerName,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    tokenUrl: body.tokenUrl,
    scopes: body.scopes,
  })

  const connection = await prisma.mcpConnection.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.serverUrl !== undefined && { serverUrl: body.serverUrl }),
      authType: newAuthType,
      authConfig: authConfig as Prisma.InputJsonValue,
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  return { success: true, connection: serializeConnection(connection) }
})

// ── DELETE — remove a connection ──────────────────────────────────────────

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  // Support id in JSON body or query param
  let id: string | undefined

  const url = new URL(request.url)
  const queryId = url.searchParams.get('id')

  if (queryId) {
    id = queryId
  } else {
    const body = z
      .object({ id: z.string().min(1) })
      .parse(await request.json())
    id = body.id
  }

  const result = await prisma.mcpConnection.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })

  if (!result.count) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')

  return { success: true }
})
