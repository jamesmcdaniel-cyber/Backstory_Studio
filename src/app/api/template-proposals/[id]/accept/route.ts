import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { getProposal, markAccepted } from '@/lib/templates/proposals'
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
  const template = await createTemplate({
    ...proposalToCreateTemplateArgs(proposal),
    source: 'ai_generated',
    visibility: 'org',
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
  })
  await markAccepted(id, auth.organizationId, template.id)
  return { status: 'accepted', templateId: template.id }
})
