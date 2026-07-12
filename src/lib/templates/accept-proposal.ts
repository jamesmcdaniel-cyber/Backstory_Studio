import type { TemplateProposal } from '@prisma/client'
import type { CreateTemplateParams } from '@/lib/templates/create-template'

/**
 * The AgentTemplate-shaping args a template-kind proposal contributes to
 * `createTemplate` — everything EXCEPT the caller-derived tenancy/provenance
 * fields (organizationId, userId, source, visibility), which the accept route
 * supplies. Pure so the mapping is unit-testable without a DB.
 */
export type ProposalTemplateArgs = Omit<
  CreateTemplateParams,
  'organizationId' | 'userId' | 'source' | 'visibility'
>

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Map a template-kind proposal's `configuration` blob (written by the
 * generation engine — `{ name, category, instructions, integrations,
 * exampleOutput, model, schedule? }`) into `createTemplate` args. `name` and
 * `category` are lifted to the top level (AgentTemplate columns); everything
 * else stays nested as the AgentTemplate.configuration blob. Defensive: falls
 * back to the proposal's own title/rationale when the blob omits a field, so a
 * sparse proposal still promotes to a usable template.
 */
export function proposalToCreateTemplateArgs(
  proposal: Pick<TemplateProposal, 'title' | 'rationale' | 'configuration'>,
): ProposalTemplateArgs {
  const config = asObject(proposal.configuration)
  const { name, category, description, ...rest } = config
  return {
    name: asString(name) ?? proposal.title,
    category: asString(category) ?? 'Custom',
    description: asString(description) ?? proposal.rationale,
    configuration: rest,
  }
}

/**
 * The editor-open target a process_improvement proposal points D at (an
 * existing flow or agent). Null when the proposal is not a process_improvement
 * or its configuration lacks a valid target.
 */
export function proposalImprovementTarget(
  proposal: Pick<TemplateProposal, 'configuration'>,
): { targetType: 'flow' | 'agent'; targetId: string } | null {
  const config = asObject(proposal.configuration)
  const targetType = config.targetType
  const targetId = asString(config.targetId)
  if ((targetType === 'flow' || targetType === 'agent') && targetId) {
    return { targetType, targetId }
  }
  return null
}
