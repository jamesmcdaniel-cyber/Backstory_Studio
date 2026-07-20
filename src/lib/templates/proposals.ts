import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import type { TemplateProposal } from '@prisma/client'

/**
 * CRUD for the AI proposal review queue (sub-project C). A `TemplateProposal`
 * is NOT a live template — it is a reviewable suggestion the auto-generation
 * engine writes with status 'open'; a human accepts (promoting a template-kind
 * proposal via createTemplate) or dismisses it. Every query here is org-scoped
 * (TemplateProposal is in ORG_SCOPED_MODELS — the tenant guard refuses an
 * unscoped read/update). `userId` null = an org-wide proposal.
 */

export interface ProposalInput {
  /** The rep the proposal is for; null/omitted = org-wide. */
  userId?: string | null
  title: string
  rationale: string
  /** agent_template | flow_template | process_improvement */
  kind: string
  configuration: Prisma.InputJsonValue
  sourceEvidence: Prisma.InputJsonValue
}

/**
 * Where-clause for the open queue. Pure (no DB) so the filter shape is
 * unit-testable. When `userId` is given, narrows to that rep's proposals plus
 * org-wide (null-userId) ones; without it, every open proposal for the org.
 * organizationId is always a top-level key so the tenant guard is satisfied.
 */
export function openProposalsWhere(
  organizationId: string,
  userId?: string | null,
): Prisma.TemplateProposalWhereInput {
  const where: Prisma.TemplateProposalWhereInput = { organizationId, status: 'open' }
  if (userId != null) {
    where.OR = [{ userId }, { userId: null }]
  }
  return where
}

/** Open proposals for the org (+ the given rep's + org-wide), newest-first. */
export async function listOpenProposals(
  organizationId: string,
  userId?: string | null,
): Promise<TemplateProposal[]> {
  return prisma.templateProposal.findMany({
    where: openProposalsWhere(organizationId, userId),
    orderBy: { createdAt: 'desc' },
  })
}

/** A single proposal, org-scoped (returns null if it belongs to another org). */
export async function getProposal(
  id: string,
  organizationId: string,
): Promise<TemplateProposal | null> {
  return prisma.templateProposal.findFirst({ where: { id, organizationId } })
}

/** Bulk-create open proposals for the org. Returns the number written. */
export async function writeProposals(
  organizationId: string,
  rows: ProposalInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const result = await prisma.templateProposal.createMany({
    data: rows.map((r) => ({
      organizationId,
      userId: r.userId ?? null,
      title: r.title,
      rationale: r.rationale,
      kind: r.kind,
      configuration: r.configuration,
      status: 'open',
      sourceEvidence: r.sourceEvidence,
    })),
  })
  return result.count
}

/**
 * Accept a proposal: flip status to 'accepted' and stamp the created template
 * id (omitted for a process_improvement proposal, which creates no template).
 * Idempotent-safe: the `status: 'open'` guard means a second accept is a no-op
 * (count 0) rather than re-stamping a terminal row.
 */
export async function markAccepted(
  id: string,
  organizationId: string,
  createdTemplateId?: string | null,
): Promise<Prisma.BatchPayload> {
  return prisma.templateProposal.updateMany({
    where: { id, organizationId, status: 'open' },
    data: { status: 'accepted', createdTemplateId: createdTemplateId ?? undefined },
  })
}

/**
 * Stamp the created template id onto an already-accepted proposal. Best-effort
 * second step of the accept flow: the proposal is claimed (markAccepted) BEFORE
 * the template is created so a retry can't double-create, then this records the
 * resulting id for the idempotent-return path.
 */
export async function stampCreatedTemplate(
  id: string,
  organizationId: string,
  createdTemplateId: string,
): Promise<Prisma.BatchPayload> {
  return prisma.templateProposal.updateMany({
    where: { id, organizationId },
    data: { createdTemplateId },
  })
}

/**
 * Reopen a proposal that was claimed (accepted) but whose template creation then
 * failed, so a retry can create it cleanly instead of leaving a stuck 'accepted'
 * row with no template. Guarded to accepted-but-unstamped rows so it can never
 * reopen a genuinely fulfilled proposal.
 */
export async function reopenUnfulfilled(
  id: string,
  organizationId: string,
): Promise<Prisma.BatchPayload> {
  return prisma.templateProposal.updateMany({
    where: { id, organizationId, status: 'accepted', createdTemplateId: null },
    data: { status: 'open' },
  })
}

/**
 * Dismiss a proposal (terminal). Idempotent-safe via the `status: 'open'`
 * guard — dismissing an already-terminal proposal is a no-op (count 0).
 */
export async function markDismissed(
  id: string,
  organizationId: string,
): Promise<Prisma.BatchPayload> {
  return prisma.templateProposal.updateMany({
    where: { id, organizationId, status: 'open' },
    data: { status: 'dismissed' },
  })
}
