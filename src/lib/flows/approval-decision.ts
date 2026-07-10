/**
 * Approval decision replies for flow runs paused on a tool-step approval.
 *
 * decideApproval resumes a paused flow run with a JSON reply of
 * { status: 'approved'|'rejected', approvalId, executed?, result?, message? }.
 * Parsing and the consume decision are pure so the flow executor and its
 * tests share one implementation.
 */

export type ApprovalDecisionReply = {
  status?: string
  approvalId?: string
  executed?: boolean
  result?: unknown
  message?: string
}

/** Parse a resume reply into a decision object, or null if it isn't one. */
export function parseApprovalDecision(reply: string): ApprovalDecisionReply | null {
  try {
    const parsed = JSON.parse(reply)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ApprovalDecisionReply) : null
  } catch {
    return null
  }
}

/**
 * Should a resuming tool step consume this decision? Only when the decision
 * correlates — by approvalId — with an approval the run was actually paused
 * on. In a loop/parallel several items pause on their OWN approvals; another
 * item's decision must never be reported as this step's result. A step that
 * doesn't consume falls through to its normal execution path and re-queues
 * its own approval.
 */
export function shouldConsumeApprovalDecision(
  decision: ApprovalDecisionReply | null,
  pausedApprovalIds: ReadonlySet<string>,
): boolean {
  if (!decision?.approvalId) return false
  if (decision.status !== 'approved' && decision.status !== 'rejected') return false
  return pausedApprovalIds.has(decision.approvalId)
}
