import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { slackConfigured } from '@/lib/integrations/slack'
import { emailConfigured } from '@/lib/integrations/email'
import { granolaConfigured } from '@/lib/integrations/granola'

/**
 * GET /api/integrations/available
 *
 * Every tool the org can attach to an agent, unified across planes so the
 * create-agent form shows what's ACTUALLY configured (not just env builtins):
 *  - `tools`: a deduped, logo-tagged list merging built-ins (Slack/Email/
 *    Granola), Nango-connected accounts, and Klavis-provisioned MCP servers.
 *    Each `key` is the string the agent runtime matches (loadTools): built-ins
 *    and Nango by capability regex (/slack/i, /gmail/i, …), Klavis by agentType.
 *  - `connections`: the org's custom Backstory-MCP connections (id + name),
 *    which the runtime loads for every agent regardless of selection.
 *
 * Connection state is read from the mirror tables (nango_connections,
 * mcp_agents) — the same source the runtime uses — so this stays a fast DB
 * read with no external Nango/Klavis round-trips.
 */

type ToolChip = { key: string; label: string; slug: string; connected: boolean }

const titleCase = (s: string) =>
  s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Nango providerConfigKey → a runtime-matchable key + display + Simple Icons slug.
function fromNango(providerConfigKey: string): { key: string; label: string; slug: string } {
  const k = providerConfigKey.toLowerCase()
  if (k.includes('slack')) return { key: 'slack', label: 'Slack', slug: 'slack' }
  if (k.includes('mail') || k.includes('gmail')) return { key: 'gmail', label: 'Gmail', slug: 'gmail' }
  if (k.includes('salesforce')) return { key: 'salesforce', label: 'Salesforce', slug: 'salesforce' }
  return { key: k, label: titleCase(k), slug: k }
}

// Klavis agentType (e.g. "GITHUB", "GOOGLE_DRIVE") → key (lowercase, matches the
// runtime's agentType.toUpperCase() check) + display + Simple Icons slug.
const KLAVIS_LABELS: Record<string, string> = {
  github: 'GitHub', google_drive: 'Google Drive', google_sheets: 'Google Sheets',
  hubspot: 'HubSpot', clickup: 'ClickUp',
}
const KLAVIS_SLUGS: Record<string, string> = {
  google_drive: 'googledrive', google_sheets: 'googlesheets', monday: 'mondaydotcom',
}
function fromKlavis(agentType: string): { key: string; label: string; slug: string } {
  const key = agentType.toLowerCase()
  return { key, label: KLAVIS_LABELS[key] ?? titleCase(key), slug: KLAVIS_SLUGS[key] ?? key }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const [connections, hasGranola, nango, klavis] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    }),
    granolaConfigured(organizationId),
    prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    }),
    prisma.mCPAgent.findMany({
      where: { organizationId, isActive: true },
      select: { agentType: true },
    }),
  ])

  // Merge planes, deduping by lowercased key and OR-ing connected state. Builtins
  // are added first so their canonical labels/keys (Slack/Email/Granola) win.
  const byKey = new Map<string, ToolChip>()
  const add = (chip: ToolChip) => {
    const id = chip.key.toLowerCase()
    const existing = byKey.get(id)
    if (existing) existing.connected = existing.connected || chip.connected
    else byKey.set(id, chip)
  }

  add({ key: 'Slack', label: 'Slack', slug: 'slack', connected: slackConfigured() })
  add({ key: 'Email', label: 'Email', slug: 'resend', connected: emailConfigured() })
  add({ key: 'Granola', label: 'Granola', slug: 'granola', connected: hasGranola })

  for (const c of nango) {
    const m = fromNango(c.providerConfigKey)
    add({ ...m, connected: true })
  }
  for (const a of klavis) {
    const m = fromKlavis(a.agentType)
    add({ ...m, connected: true })
  }

  // Connected first, then alphabetical, so the user's real tools lead.
  const tools = [...byKey.values()].sort((a, b) =>
    a.connected === b.connected ? a.label.localeCompare(b.label) : a.connected ? -1 : 1,
  )

  return {
    success: true,
    tools,
    connections: connections.map((c) => ({ id: c.id, name: c.name })),
  }
})
