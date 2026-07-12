import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let buildUsageProfile: any
  const ids: Record<string, string> = {}

  const audit = (orgId: string, provider: string, tool: string, runId: string) =>
    prisma.auditEvent.create({
      data: { organizationId: orgId, action: 'tool.call', resourceType: provider, tool, executionId: runId },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ buildUsageProfile } = await import('@/lib/templates/usage-profile'))

    const orgA = await prisma.organization.create({ data: { name: 'usage A', slug: `usage-a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'usage B', slug: `usage-b-${Date.now()}` } })
    ids.orgA = orgA.id
    ids.orgB = orgB.id
    const userA = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `usageA-${Date.now()}@example.com`, name: 'A', organizationId: orgA.id },
    })
    ids.userA = userA.id

    // orgA audit activity: two runs that both use {slack, gmail}.
    await audit(orgA.id, 'slack', 'send_message', 'exec1')
    await audit(orgA.id, 'gmail', 'send_email', 'exec1')
    await audit(orgA.id, 'gmail', 'read_thread', 'exec2')
    await audit(orgA.id, 'slack', 'send_message', 'exec2')

    // A WorkflowStep on a THIRD execution not present in the audit slice — the
    // thin-org fallback should fold it in (and split 'people.ai.get_account' on
    // the LAST dot so the dotted provider survives).
    const wfExec = await prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', status: 'succeeded', input: {}, trigger: {}, userId: userA.id, organizationId: orgA.id },
    })
    ids.wfExec = wfExec.id
    await prisma.workflowStep.create({ data: { executionId: wfExec.id, node: 'people.ai.get_account', status: 'succeeded' } })

    // orgB activity must never leak into orgA's profile.
    await audit(orgB.id, 'slack', 'send_message', 'execB')
  })

  after(async () => {
    if (ids.orgA) await prisma.organization.delete({ where: { id: ids.orgA } }).catch(() => {})
    if (ids.orgB) await prisma.organization.delete({ where: { id: ids.orgB } }).catch(() => {})
  })

  test('buildUsageProfile aggregates org-scoped audit + workflow activity, no cross-org leak', async () => {
    const profile = await buildUsageProfile(ids.orgA)

    // providers: slack=2, gmail=2, people.ai=1 (from the folded-in workflow step).
    const providerMap = Object.fromEntries(profile.providers.map((p: any) => [p.provider, p.calls]))
    assert.equal(providerMap.slack, 2, 'orgB slack activity must not inflate orgA (would be 3)')
    assert.equal(providerMap.gmail, 2)
    assert.equal(providerMap['people.ai'], 1, 'dotted provider folded in from WorkflowStep.node')

    // co-occurrence: both audit runs share {gmail, slack}.
    assert.deepEqual(profile.coOccurrence, [{ providers: ['gmail', 'slack'], runs: 2 }])

    // runCount = 3 distinct runs (exec1, exec2, the workflow execution).
    assert.equal(profile.runCount, 3)
    assert.equal(profile.windowDays, 90)

    // topTools includes the distinct (provider,tool) pairs, none from orgB.
    const toolKeys = profile.topTools.map((t: any) => `${t.provider}.${t.tool}`)
    assert.ok(toolKeys.includes('slack.send_message'))
    assert.ok(toolKeys.includes('gmail.read_thread'))
  })

  test('buildUsageProfile counts only genuine tool actions, not lifecycle/approval events', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage filter', slug: `usage-filter-${Date.now()}` } })
    try {
      const ev = (action: string, resourceType: string | null, tool: string | null, runId: string | null) =>
        prisma.auditEvent.create({ data: { organizationId: org.id, action, resourceType, tool, executionId: runId } })

      // A normal (non-gated) tool call — counts once.
      await ev('tool.call', 'notion', 'create_page', 'run1')
      // A lifecycle event: publishing a flow. resourceType='flow', tool=null.
      // Must NOT surface as a phantom 'flow' provider.
      await ev('flow.published', 'flow', null, null)
      // An approval-gated call: the SAME execution writes requested + approved +
      // the real tool.write, all resourceType=provider. Must count the provider
      // exactly ONCE (only the tool.write survives the action filter).
      await ev('approval.requested', 'salesforce', 'create_lead', 'run2')
      await ev('approval.approved', 'salesforce', 'create_lead', 'run2')
      await ev('tool.write', 'salesforce', 'create_lead', 'run2')

      const profile = await buildUsageProfile(org.id)
      const providerMap = Object.fromEntries(profile.providers.map((p: any) => [p.provider, p.calls]))

      assert.equal(providerMap.notion, 1, 'a normal tool.call counts once')
      assert.equal(providerMap.salesforce, 1, 'approval-gated call counts the provider exactly once (not 3)')
      assert.equal(providerMap.flow, undefined, 'flow.published lifecycle event is not a provider')
      // runCount = 2 genuine tool runs (run1, run2); the null-run lifecycle row is ignored.
      assert.equal(profile.runCount, 2)
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('buildUsageProfile is empty for an org with no activity', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage empty', slug: `usage-empty-${Date.now()}` } })
    try {
      const profile = await buildUsageProfile(org.id)
      assert.deepEqual(profile.providers, [])
      assert.deepEqual(profile.coOccurrence, [])
      assert.equal(profile.runCount, 0)
      assert.equal(profile.windowDays, 90)
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })
}
