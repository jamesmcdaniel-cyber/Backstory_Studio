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

/**
 * Distinct connected-provider keys, deduped across planes (case-insensitive).
 * Pure so the dedupe rule is unit-testable without a DB. A provider connected
 * through two planes shares one lowercased key and therefore counts once.
 */
export function distinctProviderKeys(providers: { key: string }[]): string[] {
  return [...new Set(providers.map((p) => p.key.toLowerCase()))]
}

/**
 * Count of DISTINCT integrations the org+user have connected, deduped across
 * planes — a provider reachable through two planes counts once. Org+user scoped
 * via listConnectedProviders (which is org-scoped exactly like
 * /api/integrations/available). C's generateTemplateProposals gate-checks with
 * `countConnectedIntegrations(...) >= MIN_INTEGRATIONS_FOR_TEMPLATES`.
 */
export async function countConnectedIntegrations(organizationId: string, userId: string): Promise<number> {
  const providers = await listConnectedProviders(organizationId, userId)
  return distinctProviderKeys(providers).length
}
