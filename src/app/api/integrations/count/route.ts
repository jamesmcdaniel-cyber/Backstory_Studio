import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listConnectedProviders } from '@/lib/integrations/connected'
import { MIN_INTEGRATIONS_FOR_TEMPLATES, meetsTemplateGate } from '@/lib/integrations/integration-count'

/**
 * GET /api/integrations/count
 *
 * The auto-template onboarding meter's read: how many DISTINCT integrations the
 * org has connected, the ≥3 threshold that unlocks AI template generation,
 * whether the gate is met, and the deduped providers behind the number.
 * Org+user scoped; "connected" is the same per-org definition
 * /api/integrations/available uses (see listConnectedProviders).
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const raw = await listConnectedProviders(auth.organizationId, auth.userId)

  // Dedupe across planes by the lowercased key — a provider connected two ways
  // is one integration. First occurrence wins its label.
  const seen = new Map<string, { key: string; label: string }>()
  for (const p of raw) {
    const id = p.key.toLowerCase()
    if (!seen.has(id)) seen.set(id, { key: p.key, label: p.label })
  }
  const providers = [...seen.values()]
  const connected = providers.length

  return {
    connected,
    required: MIN_INTEGRATIONS_FOR_TEMPLATES,
    meetsGate: meetsTemplateGate(connected),
    providers,
  }
})
