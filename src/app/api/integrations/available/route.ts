import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { slackConfigured } from '@/lib/integrations/slack'
import { emailConfigured } from '@/lib/integrations/email'
import { granolaConfigured } from '@/lib/integrations/granola'

/**
 * GET /api/integrations/available
 *
 * Returns two lists:
 *  - `builtins`: hard-coded integrations (Slack, Email, Granola) with a
 *    `configured` flag derived from the presence of env vars.
 *  - `connections`: the org's active MCP connections (id + name), added by
 *    users via the Connections page (e.g. Backstory MCP, GitHub, Linear).
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    select: { id: true, name: true },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    builtins: [
      { label: 'Slack', configured: slackConfigured() },
      { label: 'Email', configured: emailConfigured() },
      { label: 'Granola', configured: granolaConfigured() },
    ],
    connections: connections.map((c) => ({ id: c.id, name: c.name })),
  }
})
