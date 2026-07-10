/**
 * HTTP step connection auth — resolve a fresh bearer token for an http node's
 * optional `connectionId` at fetch time.
 *
 * v1 supports McpConnection rows only (raw ids — the same rows the flow tool
 * catalog lists), because ensureFreshConnectionToken operates on McpConnection.
 * Prefixed plane ids (people_ai:/klavis:/native:/nango:) are rejected with the
 * same plain-english error as a missing connection.
 *
 * SECRETS DISCIPLINE: the returned token is used to build the outbound request
 * header only. It must never be logged, persisted to FlowRunStep rows, or
 * included in any client payload.
 */
import { prisma } from '@/lib/prisma'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'
import { mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { mcpConnectionScope } from '@/lib/flows/tool-catalog'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

export const HTTP_CONNECTION_UNAVAILABLE =
  'The connection for this HTTP step is unavailable — reconnect it in Integrations.'

/**
 * Look up the org-scoped connection (org-shared rows plus the acting user's
 * own), refresh its OAuth token if needed, and return the bearer token value.
 * Throws HTTP_CONNECTION_UNAVAILABLE when the connection is missing, out of
 * scope, inactive, or carries no usable token.
 */
export async function resolveHttpConnectionToken(params: {
  connectionId: string
  organizationId: string
  userId?: string
}): Promise<string> {
  const { plane, ref } = parseFlowToolConnectionId(params.connectionId)
  if (plane !== 'mcp') throw new Error(HTTP_CONNECTION_UNAVAILABLE)

  const conn = await prisma.mcpConnection.findFirst({
    where: { id: ref, ...mcpConnectionScope(params.organizationId, params.userId) },
  })
  if (!conn) throw new Error(HTTP_CONNECTION_UNAVAILABLE)

  const fresh = await ensureFreshConnectionToken(conn)
  const config = mcpConfigFromConnection(fresh)
  // OAuth authcode connections carry a (just-refreshed) access token; api_key
  // connections qualify only when their key is presented as a Bearer
  // Authorization header (no custom header name) — mirroring McpClient.
  const token =
    config.authType === 'oauth2' && config.flow === 'authcode'
      ? config.accessToken
      : config.authType === 'api_key' && (!config.headerName?.trim() || config.headerName === 'Authorization')
        ? config.apiKey
        : undefined
  if (!token) throw new Error(HTTP_CONNECTION_UNAVAILABLE)
  return token
}
