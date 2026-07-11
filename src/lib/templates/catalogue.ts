import type { AgentTemplate } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'

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

export type StoredTemplateRow = { organizationId: string; source?: string | null; visibility?: string | null; updatedAt: Date }

/**
 * Rank stored templates for a viewer: the org's own templates first
 * (ai_generated above user-authored), then other orgs' global community
 * templates. Newest-first within each group. Pure — no DB.
 */
export function sortStoredTemplates<T extends StoredTemplateRow>(rows: T[], viewerOrgId: string): T[] {
  const groupOf = (row: T): number => {
    const own = row.organizationId === viewerOrgId
    if (own && (row.source ?? 'user') === 'ai_generated') return 0
    if (own) return 1
    return 2 // other orgs' global community templates
  }
  return [...rows].sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    if (ga !== gb) return ga - gb
    return b.updatedAt.getTime() - a.updatedAt.getTime()
  })
}

/**
 * The catalogue rows for a viewer: their own templates (any visibility) via the
 * tenant-guarded client, plus OTHER orgs' global community templates. The only
 * cross-org read is the global slice.
 */
export async function fetchCatalogueRows(organizationId: string): Promise<{ own: AgentTemplate[]; global: AgentTemplate[] }> {
  // Cap the own slice like the global one below — a bound on the read, not a
  // product limit (orderBy keeps the most recent if an org ever exceeds it).
  const own = await prisma.agentTemplate.findMany({ where: { organizationId, isActive: true }, orderBy: { updatedAt: 'desc' }, take: 500 })
  // systemPrisma: cross-org read of the PUBLIC community slice only — global
  // templates from OTHER orgs. Own rows come from the tenant-guarded query above.
  const globalRows = await systemPrisma.agentTemplate.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return { own, global: globalRows }
}

/** Own + global community templates, ranked own-first, serialized. */
export async function listStoredCatalogue(organizationId: string): Promise<SerializedTemplate[]> {
  const { own, global } = await fetchCatalogueRows(organizationId)
  return sortStoredTemplates([...own, ...global], organizationId).map((row) => serializeTemplate(row, organizationId))
}
