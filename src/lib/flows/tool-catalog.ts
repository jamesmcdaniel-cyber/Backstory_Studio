import { prisma } from '@/lib/prisma'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown }
export type FlowToolCatalogConnection = { id: string; name: string; tools: FlowToolSummary[] }

export async function loadFlowToolCatalog(
  organizationId: string,
  options: { takeConnections?: number; takeTools?: number; connectionIds?: string[] } = {},
): Promise<FlowToolCatalogConnection[]> {
  const connections = await prisma.mcpConnection.findMany({
    where: {
      organizationId,
      isActive: true,
      ...(options.connectionIds?.length ? { id: { in: options.connectionIds } } : {}),
    },
    take: options.takeConnections ?? 25,
  })
  return Promise.all(
    connections.map(async (conn) => {
      try {
        const fresh = await ensureFreshConnectionToken(conn)
        const client = new McpClient(mcpConfigFromConnection(fresh))
        const tools = await client.getServerTools(fresh.serverUrl)
        return {
          id: conn.id,
          name: conn.name,
          tools: tools.slice(0, options.takeTools ?? 100).map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema ?? null,
          })),
        }
      } catch {
        return { id: conn.id, name: conn.name, tools: [] }
      }
    }),
  )
}
