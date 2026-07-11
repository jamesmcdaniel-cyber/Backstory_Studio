import type { AgentTemplate } from '@prisma/client'

/** The subset of an AgentTemplate row the serializer reads (row from DB or a test fixture). */
export type AgentTemplateRow = Pick<AgentTemplate, 'id' | 'name' | 'type' | 'organizationId'> & {
  description?: string | null
  configuration?: unknown
  source?: string | null
  visibility?: string | null
}

export interface SerializedTemplate {
  id: string
  name: string
  description: string
  category: string
  instructions: string
  integrations: string[]
  skills: string[]
  tags: string[]
  model: string
  exampleOutput: string
  icon: string
  allowSubagents: boolean
  custom: boolean
  authorName: string
  source: string
  visibility: string
  mine: boolean
}

/** Serialize a stored template row for the API. `mine` gates edit/delete in the UI. */
export function serializeTemplate(template: AgentTemplateRow, viewerOrgId?: string): SerializedTemplate {
  const config = template.configuration && typeof template.configuration === 'object' ? (template.configuration as Record<string, unknown>) : {}
  return {
    id: template.id,
    name: template.name,
    description: (template.description as string) || '',
    category: template.type,
    instructions: (config.instructions as string) || (template.description as string) || '',
    integrations: (config.integrations as string[]) || [],
    skills: (config.skills as string[]) || [],
    tags: (config.tags as string[]) || [],
    model: (config.model as string) || 'gpt-4o',
    exampleOutput: (config.exampleOutput as string) || '',
    icon: (config.icon as string) || '',
    allowSubagents: config.allowSubagents === true,
    custom: true,
    authorName: (config.authorName as string) || '',
    source: template.source ?? 'user',
    visibility: template.visibility ?? 'org',
    // Only the creating org may edit/delete a template.
    mine: Boolean(viewerOrgId) && template.organizationId === viewerOrgId,
  }
}
