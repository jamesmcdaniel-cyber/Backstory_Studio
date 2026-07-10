import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  // Prove the no-external-env path: teardown must clean up the DB rows
  // without attempting any external calls when Klavis/Nango/Neo4j are
  // unconfigured.
  delete process.env.KLAVIS_API_KEY
  delete process.env.NANGO_SECRET_KEY
  delete process.env.NEO4J_URI
  delete process.env.NEO4J_USERNAME
  delete process.env.NEO4J_PASSWORD

  let prisma: any
  let teardownOrganization: (organizationId: string) => Promise<{ klavis: number; nango: number; graphCleared: boolean }>
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ teardownOrganization } = await import('@/lib/org-teardown'))

    const org = await prisma.organization.create({ data: { name: 'Teardown Org', slug: `teardown-${Date.now()}` } })
    ids.org = org.id

    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id

    const mcpAgent = await prisma.mCPAgent.create({
      data: {
        userId: user.id,
        organizationId: org.id,
        name: 'teardown_agent',
        agentType: 'SLACK',
        mcpServerUrl: 'https://example.com/mcp',
        metadata: { instanceId: 'klavis-instance-1' },
      },
    })
    ids.mcpAgent = mcpAgent.id

    const nangoConnection = await prisma.nangoConnection.create({
      data: {
        organizationId: org.id,
        connectionId: `conn-${Date.now()}`,
        providerConfigKey: 'slack',
      },
    })
    ids.nangoConnection = nangoConnection.id

    const flow = await prisma.flow.create({
      data: { name: 'teardown-flow', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id
  })

  after(async () => {
    // Best-effort cleanup in case the delete under test didn't run (RED phase).
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.nangoConnection.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.mCPAgent.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: ids.org } }).catch(() => {})
  })

  test('teardownOrganization deprovisions externals (no-op when unconfigured), clears the graph, and deletes the org row + cascades', async () => {
    assert.equal(process.env.KLAVIS_API_KEY, undefined)
    assert.equal(process.env.NANGO_SECRET_KEY, undefined)
    assert.equal(process.env.NEO4J_URI, undefined)

    const result = await teardownOrganization(ids.org)

    // Env unset → each external leg no-ops without attempting a call.
    assert.equal(result.klavis, 0)
    assert.equal(result.nango, 0)
    assert.equal(result.graphCleared, false)

    const org = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.equal(org, null)

    const mcpAgentCount = await prisma.mCPAgent.count({ where: { id: ids.mcpAgent, organizationId: ids.org } })
    assert.equal(mcpAgentCount, 0)

    const nangoConnectionCount = await prisma.nangoConnection.count({ where: { id: ids.nangoConnection, organizationId: ids.org } })
    assert.equal(nangoConnectionCount, 0)

    const flowCount = await prisma.flow.count({ where: { id: ids.flow, organizationId: ids.org } })
    assert.equal(flowCount, 0)
  })
}
