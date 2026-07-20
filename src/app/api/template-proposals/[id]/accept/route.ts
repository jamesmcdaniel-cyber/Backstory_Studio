import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { getProposal, markAccepted, stampCreatedTemplate, reopenUnfulfilled } from '@/lib/templates/proposals'
import { createTemplate } from '@/lib/templates/create-template'
import {
  proposalToCreateTemplateArgs,
  proposalImprovementTarget,
} from '@/lib/templates/accept-proposal'

// POST /api/template-proposals/[id]/accept — promote an open proposal.
//   agent_template | flow_template → create a real org-scoped, AI-generated
//     AgentTemplate via A's single writer, stamp createdTemplateId, return its id.
//   process_improvement → create NO template; return the flow/agent editor target
//     for D to open prefilled.
// Idempotent: an already-accepted/dismissed proposal returns its current state
// without re-creating (mirrors decideApproval's non-pending short-circuit).
// Org-scoped: a missing/other-org proposal 404s.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Proposal id is required')

  const proposal = await getProposal(id, auth.organizationId)
  if (!proposal) throw new ApiError('Proposal not found', 404, 'NOT_FOUND')

  const isImprovement = proposal.kind === 'process_improvement'

  // Idempotent: terminal proposals report their existing outcome, never re-create.
  if (proposal.status !== 'open') {
    if (proposal.status === 'accepted') {
      return isImprovement
        ? { status: 'accepted', open: proposalImprovementTarget(proposal) }
        : { status: 'accepted', templateId: proposal.createdTemplateId }
    }
    return { status: proposal.status }
  }

  if (isImprovement) {
    // No template — the client opens the existing flow/agent editor prefilled.
    await markAccepted(id, auth.organizationId)
    return { status: 'accepted', open: proposalImprovementTarget(proposal) }
  }

  // Template kind: the ONLY path that creates a live template — always via A's
  // writer as an org-scoped, AI-generated template (never global, never cross-org).
  //
  // Claim the proposal atomically BEFORE creating anything: markAccepted's
  // status:'open' guard means only one accept can win, so a retry after a partial
  // failure — or a concurrent double-accept — can never mint a duplicate template.
  const claim = await markAccepted(id, auth.organizationId)
  if (claim.count === 0) {
    // Lost the claim (already accepted/dismissed) — return the current outcome
    // idempotently rather than creating a second template.
    const current = await getProposal(id, auth.organizationId)
    if (current?.status === 'accepted') return { status: 'accepted', templateId: current.createdTemplateId }
    return { status: current?.status ?? 'dismissed' }
  }

  let template
  try {
    template = await createTemplate({
      ...proposalToCreateTemplateArgs(proposal),
      source: 'ai_generated',
      visibility: 'org',
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    })
  } catch (error) {
    // Creation failed after we claimed the proposal — reopen it so a retry can
    // create the template cleanly, instead of stranding an accepted row with no
    // template. (No-op if something already stamped it.)
    await reopenUnfulfilled(id, auth.organizationId).catch(() => undefined)
    throw error
  }
  // Record the created id for the idempotent-return path (best-effort: the
  // accept itself already committed, so a failure here only costs the id echo).
  await stampCreatedTemplate(id, auth.organizationId, template.id).catch(() => undefined)
  return { status: 'accepted', templateId: template.id }
})
