import { prisma } from '@/lib/prisma'
import type { AgentTemplate } from '@prisma/client'

export interface CreateTemplateParams {
  organizationId: string
  userId: string
  name: string
  /** UI/domain category — stored in the `type` column. */
  category: string
  description?: string
  /** The configuration blob (instructions, integrations, skills, tags, model, …). */
  configuration: Record<string, unknown>
  source?: 'user' | 'ai_generated'
  visibility?: 'org' | 'global'
}

/**
 * The single writer for AgentTemplate rows. Both the manual POST route and the
 * auto-generation engine's proposal-approval path (sub-project C) go through
 * here so provenance (`source`) and scope (`visibility`) are always set.
 */
export async function createTemplate(params: CreateTemplateParams): Promise<AgentTemplate> {
  return prisma.agentTemplate.create({
    data: {
      name: params.name,
      description: params.description ?? '',
      type: params.category,
      configuration: params.configuration,
      userId: params.userId,
      organizationId: params.organizationId,
      source: params.source ?? 'user',
      visibility: params.visibility ?? 'org',
    },
  })
}
