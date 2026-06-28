import { z } from 'zod'
import { McpClient } from '@/lib/mcp/mcp-client'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Same schema as the main route (without id, without isActive)
const testSchema = z.object({
  name: z.string().min(1).optional(),
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
})

export const POST = withAuthenticatedApi(async (request, _auth) => {
  const data = testSchema.parse(await request.json())

  // Build runtime config directly from plaintext input — do NOT persist
  const client = new McpClient({
    serverUrl: data.serverUrl,
    authType: data.authType,
    apiKey: data.apiKey,
    headerName: data.headerName,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    tokenUrl: data.tokenUrl,
    scopes: data.scopes,
  })

  try {
    const tools = await client.getServerTools(data.serverUrl)
    const limited = tools.slice(0, 30)
    return {
      ok: true,
      toolCount: tools.length,
      toolNames: limited.map((t) => t.name),
    }
  } catch (error) {
    // Never leak secrets or internal stack traces
    const message =
      error instanceof Error ? error.message : 'Connection failed'

    // Scrub any potential credential leakage from the message
    const safeMessage = message
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[redacted]')
      .substring(0, 300)

    return { ok: false, error: safeMessage }
  }
})
