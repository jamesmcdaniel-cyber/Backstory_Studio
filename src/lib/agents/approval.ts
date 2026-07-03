/**
 * Approval gate for outbound writes.
 *
 * When an agent is configured with `requireApproval`, its write-plane tool
 * calls (Nango delivery: Slack/Gmail/Salesforce) are not executed inline.
 * Instead an ApprovalRequest is created and the model is told the action is
 * queued; an approver later approves (the write runs) or rejects (it's
 * dropped). Every decision is audited. This avoids pausing/resuming the whole
 * multi-turn run while still gating side effects.
 */

import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import {
  DELIVERY_TOOLS,
  resolveDeliveryConnection,
  type DeliveryCapability,
} from '@/lib/nango/delivery'

/** Write planes that an approval gate applies to (delivery/outbound). */
const WRITE_PLANE = /^nango:(slack|gmail|salesforce)$/

export function requiresApproval(
  agentMetadata: Record<string, unknown> | null | undefined,
  provider: string,
): boolean {
  const flag = agentMetadata?.requireApproval
  return flag === true && WRITE_PLANE.test(provider)
}

export function capabilityFromProvider(provider: string): DeliveryCapability | null {
  const match = WRITE_PLANE.exec(provider)
  return match ? (match[1] as DeliveryCapability) : null
}

export async function createApproval(input: {
  organizationId: string
  executionId: string
  userId: string
  provider: string
  tool: string
  args: Record<string, unknown>
}): Promise<{ id: string }> {
  const capability = capabilityFromProvider(input.provider)
  const summary = `${input.tool} (${capability ?? input.provider})`
  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      executionId: input.executionId,
      tool: input.tool,
      summary,
      payload: { provider: input.provider, capability, args: input.args, userId: input.userId } as never,
      status: 'pending',
    },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: input.executionId,
    actorUserId: input.userId,
    actorKind: 'agent',
    action: 'approval.requested',
    tool: input.tool,
    resourceType: input.provider,
    resourceId: approval.id,
    payload: input.args,
  })
  return { id: approval.id }
}

export interface DecideResult {
  status: 'approved' | 'rejected'
  executed: boolean
}

/**
 * Approve (execute the queued write) or reject (drop it) an approval, scoped to
 * the deciding user's organization. Idempotent: a non-pending request returns
 * its current state without re-executing.
 */
export async function decideApproval(input: {
  approvalId: string
  organizationId: string
  deciderUserId: string
  approve: boolean
}): Promise<DecideResult> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalId, organizationId: input.organizationId },
  })
  if (!approval) throw new Error('Approval not found')
  if (approval.status !== 'pending') {
    return { status: approval.status as 'approved' | 'rejected', executed: false }
  }

  if (!input.approve) {
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { status: 'rejected', decidedById: input.deciderUserId, decidedAt: new Date() },
    })
    await recordAudit({
      organizationId: input.organizationId,
      executionId: approval.executionId,
      actorUserId: input.deciderUserId,
      action: 'approval.rejected',
      tool: approval.tool,
      resourceId: approval.id,
    })
    return { status: 'rejected', executed: false }
  }

  // Approved — execute the queued delivery write now.
  const payload = approval.payload as {
    provider: string
    capability: DeliveryCapability | null
    args: Record<string, unknown>
    userId: string
  }
  let executed = false
  if (payload.capability) {
    const spec = DELIVERY_TOOLS.find((tool) => tool.capability === payload.capability)
    const connection = await resolveDeliveryConnection(input.organizationId, payload.capability, payload.userId)
    if (spec && connection) {
      await spec.run(connection, payload.args)
      executed = true
    }
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: { status: 'approved', decidedById: input.deciderUserId, decidedAt: new Date() },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: approval.executionId,
    actorUserId: input.deciderUserId,
    action: 'approval.approved',
    tool: approval.tool,
    resourceType: payload.provider,
    resourceId: approval.id,
    payload: payload.args,
  })
  return { status: 'approved', executed }
}
