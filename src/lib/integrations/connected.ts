import { prisma } from '@/lib/prisma'
import { granolaConfigured } from '@/lib/integrations/granola'
import { getOrgStrataConnection, getStrataServerNames, isStrataUrl, STRATA_KEY_PREFIX } from '@/lib/mcp/strata'
import {
  BUILTIN_CONNECTORS,
  fromNangoProviderKey,
  fromKlavisAgentType,
} from '@/lib/connectors/registry'

/**
 * Single source of "connected" across the org's integration planes.
 *
 * The five-plane merge that /api/integrations/available renders lived inline in
 * that route; it now lives here so the create-agent picker AND the auto-template
 * gate agree on what "connected" means. Both projections read the SAME planes:
 *  - `getAvailableIntegrations` reproduces the route's payload byte-for-byte
 *    (every attachable tool, connected or not, plus Strata chips + custom
 *    connections).
 *  - `listConnectedProviders` returns just the providers the ORG has actually
 *    connected — the input the ≥3-integration template gate counts.
 */

export type ToolChip = { key: string; label: string; slug: string; connected: boolean }

export type AvailableIntegrations = {
  tools: ToolChip[]
  strataTools: ToolChip[]
  connections: { id: string; name: string }[]
}

// Raw per-plane reads, done once so both projections stay in lockstep. All
// reads are org-scoped (the tenant-guard invariant); Granola is read separately
// per projection because the two need different definitions of it (see below).
type PlaneReads = {
  connectionsRaw: { id: string; name: string; serverUrl: string }[]
  nango: { providerConfigKey: string }[]
  klavis: { agentType: string }[]
  strataServers: string[]
}

async function readPlanes(organizationId: string): Promise<PlaneReads> {
  const [connectionsRaw, nango, klavis, strataConnection] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true, serverUrl: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    }),
    prisma.mCPAgent.findMany({
      where: { organizationId, isActive: true },
      select: { agentType: true },
    }),
    getOrgStrataConnection(organizationId),
  ])
  const strataServers = strataConnection ? await getStrataServerNames(strataConnection) : []
  return { connectionsRaw, nango, klavis, strataServers }
}

/**
 * The /api/integrations/available payload: every tool the org can attach, merged
 * across planes with a per-tool `connected` flag. Extracted verbatim from the
 * route so its response stays byte-identical — the route just spreads this under
 * `success: true`.
 */
export async function getAvailableIntegrations(organizationId: string): Promise<AvailableIntegrations> {
  const [{ connectionsRaw, nango, klavis, strataServers }, hasGranola] = await Promise.all([
    readPlanes(organizationId),
    granolaConfigured(organizationId),
  ])

  // The Strata connection is surfaced as individual per-server chips below, not
  // as one opaque "connection" chip.
  const connections = connectionsRaw.filter((c) => !isStrataUrl(c.serverUrl))

  // Each Strata server is an attachable tool keyed `strata:<server>`. Selecting
  // some scopes the agent to only those (see loadTools); selecting none means
  // the agent gets no Strata tools — so agents no longer carry all 90 at once.
  const strataTools: ToolChip[] = strataServers.map((name) => ({
    key: `${STRATA_KEY_PREFIX}${name}`,
    label: name.replace(/\b\w/g, (ch) => ch.toUpperCase()),
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    connected: true,
  }))

  // Merge planes, deduping by lowercased key and OR-ing connected state. Builtins
  // are added first so their canonical labels/keys (Slack/Email/Granola) win.
  const byKey = new Map<string, ToolChip>()
  const add = (chip: ToolChip) => {
    const id = chip.key.toLowerCase()
    const existing = byKey.get(id)
    if (existing) existing.connected = existing.connected || chip.connected
    else byKey.set(id, chip)
  }

  // Built-in delivery/meeting planes, straight from the registry. Granola's
  // availability is per-org (an API key), the rest come from env via available().
  for (const c of BUILTIN_CONNECTORS) {
    if (c.kind !== 'builtin') continue
    // Resend email is redundant with Gmail delivery, so it's retired from the
    // picker. The registry entry stays so the runtime email plane still works
    // for any agent that already has it selected.
    if (c.providerId === 'email') continue
    add({ key: c.key, label: c.label, slug: c.slug, connected: c.key === 'Granola' ? hasGranola : c.available() })
  }

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    add({ ...m, connected: true })
  }
  for (const a of klavis) {
    const m = fromKlavisAgentType(a.agentType)
    add({ ...m, connected: true })
  }

  // Connected first, then alphabetical, so the user's real tools lead.
  const tools = [...byKey.values()].sort((a, b) =>
    a.connected === b.connected ? a.label.localeCompare(b.label) : a.connected ? -1 : 1,
  )

  return { tools, strataTools, connections: connections.map((c) => ({ id: c.id, name: c.name })) }
}

export type ConnectedPlane = 'nango' | 'klavis' | 'mcp' | 'strata' | 'builtin'
export type ConnectedProvider = { key: string; label: string; plane: ConnectedPlane }

/**
 * Every provider the ORG has actually connected — the input the template gate
 * counts. One entry PER PLANE a provider is connected through, so a provider
 * reachable via two planes (e.g. Slack via Nango and via Klavis) appears TWICE;
 * collapsing duplicates is countConnectedIntegrations' job, not this function's.
 *
 * Distinct-provider KEY = the lowercased registry key
 * (fromNangoProviderKey / fromKlavisAgentType), the SAME dedupe key
 * /api/integrations/available uses — so 'slack' via Nango and 'SLACK' via Klavis
 * collapse to one integration. Custom MCP connections and Strata servers get
 * plane-prefixed keys (`mcp:<id>`, `strata:<server>`) because each configured
 * server is its own integration and must not collide with a provider slug.
 *
 * This is the CONNECTED subset of getAvailableIntegrations, and deliberately
 * NARROWER than "every chip whose `connected` flag is true": the always-on
 * platform builtins (HTTP API, Backstory) and env-configured Slack/Email are
 * capabilities every org has, not integrations THIS org connected — counting
 * them would inflate every org past the gate and make the number env-dependent.
 * Granola is the one builtin that counts, and only via a per-ORG API key
 * (integration_secrets) — never the GRANOLA_API_KEY env fallback that
 * granolaConfigured() also honors, since an env key is platform-level.
 *
 * Org-scoped exactly like /api/integrations/available (all of the org's
 * connections, not just this user's). `_userId` is accepted for signature parity
 * with the user-scoped plane; the connected planes are org-visible today.
 */
export async function listConnectedProviders(
  organizationId: string,
  _userId: string,
): Promise<ConnectedProvider[]> {
  const [{ connectionsRaw, nango, klavis, strataServers }, granolaSecret] = await Promise.all([
    readPlanes(organizationId),
    prisma.integrationSecret.findUnique({
      where: { organizationId_provider: { organizationId, provider: 'granola' } },
      select: { isActive: true },
    }),
  ])

  const providers: ConnectedProvider[] = []

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    providers.push({ key: m.key.toLowerCase(), label: m.label, plane: 'nango' })
  }
  for (const a of klavis) {
    const m = fromKlavisAgentType(a.agentType)
    providers.push({ key: m.key.toLowerCase(), label: m.label, plane: 'klavis' })
  }
  // Custom (non-Strata) MCP connections — each configured server is its own
  // integration, keyed by id so two distinct servers never collapse.
  for (const c of connectionsRaw) {
    if (isStrataUrl(c.serverUrl)) continue
    providers.push({ key: `mcp:${c.id.toLowerCase()}`, label: c.name, plane: 'mcp' })
  }
  // Strata aggregates many servers behind one connection; each server counts.
  for (const name of strataServers) {
    providers.push({
      key: `${STRATA_KEY_PREFIX}${name.toLowerCase()}`,
      label: name.replace(/\b\w/g, (ch) => ch.toUpperCase()),
      plane: 'strata',
    })
  }
  if (granolaSecret?.isActive) {
    providers.push({ key: 'granola', label: 'Granola', plane: 'builtin' })
  }

  return providers
}
