import { listConnectedProviders } from './connected'

/**
 * The auto-template gate: AI template generation unlocks once the org has
 * connected at least this many DISTINCT integrations (design §B). Below it, the
 * onboarding meter shows progress; at or above it, generation is available.
 */
export const MIN_INTEGRATIONS_FOR_TEMPLATES = 3

/** True once the org has connected enough distinct integrations to generate templates. */
export function meetsTemplateGate(count: number): boolean {
  return count >= MIN_INTEGRATIONS_FOR_TEMPLATES
}

export type ConnectedIntegration = { key: string; label: string }
export type ConnectedIntegrationsSummary = { count: number; providers: ConnectedIntegration[] }

/**
 * The SINGLE dedupe of connected providers across planes: a provider connected
 * two ways is one integration (case-insensitive on the key); the first occurrence
 * wins its label. Pure so the rule is unit-testable without a DB. Both the count
 * and the /api/integrations/count read go through this, so the number and the
 * providers behind it can never drift.
 */
export function dedupeConnectedProviders(providers: ConnectedIntegration[]): ConnectedIntegration[] {
  const seen = new Map<string, ConnectedIntegration>()
  for (const p of providers) {
    const id = p.key.toLowerCase()
    if (!seen.has(id)) seen.set(id, { key: p.key, label: p.label })
  }
  return [...seen.values()]
}

/**
 * Distinct connected-provider keys (lowercased), deduped across planes. Thin
 * lowercased view over {@link dedupeConnectedProviders} so there is ONE dedupe
 * rule; a provider connected through two planes counts once.
 */
export function distinctProviderKeys(providers: { key: string }[]): string[] {
  return dedupeConnectedProviders(providers.map((p) => ({ key: p.key, label: '' }))).map((p) =>
    p.key.toLowerCase(),
  )
}

/**
 * The org+user's connected integrations, deduped across planes: the count AND the
 * providers behind it from ONE read + ONE dedupe. Org+user scoped via
 * listConnectedProviders (org-scoped exactly like /api/integrations/available).
 * The read endpoint and countConnectedIntegrations both call this.
 */
export async function summarizeConnectedIntegrations(
  organizationId: string,
  userId: string,
): Promise<ConnectedIntegrationsSummary> {
  const raw = await listConnectedProviders(organizationId, userId)
  const providers = dedupeConnectedProviders(raw)
  return { count: providers.length, providers }
}

/**
 * Count of DISTINCT integrations the org+user have connected, deduped across
 * planes — a provider reachable through two planes counts once. C's
 * generateTemplateProposals gate-checks with
 * `countConnectedIntegrations(...) >= MIN_INTEGRATIONS_FOR_TEMPLATES`.
 */
export async function countConnectedIntegrations(organizationId: string, userId: string): Promise<number> {
  return (await summarizeConnectedIntegrations(organizationId, userId)).count
}
