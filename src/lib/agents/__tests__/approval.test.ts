import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { requiresApproval, capabilityFromProvider } from '../approval'

test('requiresApproval only when flag set AND provider is a write plane', () => {
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:slack', true), true)
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:gmail', true), true)
  assert.equal(requiresApproval({ requireApproval: true }, 'people_ai', true), false)
  assert.equal(requiresApproval({ requireApproval: true }, 'backstory', true), false)
  assert.equal(requiresApproval({ requireApproval: false }, 'nango:slack', true), false)
  assert.equal(requiresApproval({}, 'nango:slack', true), false)
})

test('requiresApproval never gates a READ, even on a write plane', () => {
  // slack_read_messages shares the nango:slack plane with the send tool. Gating
  // on the provider alone queued reads for approval — and, worse, approving one
  // used to run the plane's send tool.
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:slack', false), false)
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:gmail', false), false)
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:salesforce', false), false)
})

test('requiresApproval defaults to off, so an agent without the flag is never gated', () => {
  // The flag was unreachable (absent from agentSchema) until it was added to the
  // API + form; unset must keep meaning "run inline".
  assert.equal(requiresApproval(undefined, 'nango:slack', true), false)
  assert.equal(requiresApproval(null, 'nango:slack', true), false)
})

test('capabilityFromProvider extracts the delivery capability', () => {
  assert.equal(capabilityFromProvider('nango:salesforce'), 'salesforce')
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let createApproval: any
  let decideApproval: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ createApproval, decideApproval } = await import('../approval'))
    const org = await prisma.organization.create({ data: { name: 'Ap', slug: `ap-${Date.now()}` } })
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    const agent = await prisma.agentTask.create({
      data: { description: 'a', objective: 'o', status: 'ACTIVE', agentType: 'assistant', organizationId: org.id, userId: user.id },
    })
    const execution = await prisma.agentExecution.create({
      data: { agentType: 'assistant', agentTaskId: agent.id, status: 'running', input: {}, trigger: {}, userId: user.id, organizationId: org.id },
    })
    ids.org = org.id
    ids.user = user.id
    ids.execution = execution.id
  })

  after(async () => {
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.approvalRequest.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentExecution.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentTask.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.$disconnect()
  })

  test('rejecting an approval marks it rejected, does not execute, and audits', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: { channel: '#x', text: 'hi' },
    })
    const result = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    assert.deepEqual(result, { status: 'rejected', executed: false })
    const audit = await prisma.auditEvent.findMany({ where: { organizationId: ids.org, action: 'approval.rejected' } })
    assert.equal(audit.length, 1)
  })

  test('deciding a non-pending approval is idempotent', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    const second = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(second.status, 'rejected')
    assert.equal(second.executed, false)
  })

  test('deciding a superseded approval reports superseded, never executes, never resumes', async () => {
    // A resumed flow run supersedes its still-pending approvals (the re-run
    // re-queues fresh ones) — approving the stale one must be an inert no-op.
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await prisma.approvalRequest.update({ where: { id, organizationId: ids.org }, data: { status: 'superseded' } })
    const result = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.deepEqual(result, { status: 'superseded', executed: false })
    const current = await prisma.approvalRequest.findUnique({ where: { id, organizationId: ids.org } })
    assert.equal(current.status, 'superseded')
  })

  test('an approved-but-not-executed delivery is not counted as a real tool call', async () => {
    // No Nango connection exists in the test env, so spec.run never runs and the
    // decision returns executed:false. The usage-counted 'approval.approved'
    // audit (TOOL_USAGE_ACTIONS) must NOT be emitted — only a distinct,
    // profile-ignored 'approval.approved_noexec' row — so buildUsageProfile
    // never counts a delivery that never happened.
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: { channel: '#x', text: 'hi' },
    })
    const result = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(result.status, 'approved')
    assert.equal(result.executed, false)
    const counted = await prisma.auditEvent.findMany({ where: { organizationId: ids.org, resourceId: id, action: 'approval.approved' } })
    assert.equal(counted.length, 0, 'no usage-counted approval.approved row when the write never ran')
    const noexec = await prisma.auditEvent.findMany({ where: { organizationId: ids.org, resourceId: id, action: 'approval.approved_noexec' } })
    assert.equal(noexec.length, 1, 'a profile-ignored decision audit is still recorded')
  })

  test('cross-org decision is refused', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await assert.rejects(
      decideApproval({ approvalId: id, organizationId: crypto.randomUUID(), deciderUserId: ids.user, approve: true }),
      /Approval not found/,
    )
  })
}
