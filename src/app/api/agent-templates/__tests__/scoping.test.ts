import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let fetchCatalogueRows: any
  const ids: Record<string, string> = {}

  const mkTemplate = (orgId: string, userId: string, name: string, visibility: string) =>
    prisma.agentTemplate.create({ data: { name, type: 'Sales', configuration: { instructions: 'x' }, userId, organizationId: orgId, visibility } })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ fetchCatalogueRows } = await import('@/lib/templates/catalogue'))
    const orgA = await prisma.organization.create({ data: { name: 'scope A', slug: `scope-a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'scope B', slug: `scope-b-${Date.now()}` } })
    ids.orgA = orgA.id
    ids.orgB = orgB.id
    const userA = await prisma.user.create({ data: { email: `scopeA-${Date.now()}@example.com`, name: 'A', organizationId: orgA.id } })
    const userB = await prisma.user.create({ data: { email: `scopeB-${Date.now()}@example.com`, name: 'B', organizationId: orgB.id } })
    ids.aOrg = (await mkTemplate(orgA.id, userA.id, 'A-org', 'org')).id
    ids.aGlobal = (await mkTemplate(orgA.id, userA.id, 'A-global', 'global')).id
    ids.bOrg = (await mkTemplate(orgB.id, userB.id, 'B-org', 'org')).id
    ids.bGlobal = (await mkTemplate(orgB.id, userB.id, 'B-global', 'global')).id
  })

  after(async () => {
    if (ids.orgA) await prisma.organization.delete({ where: { id: ids.orgA } }).catch(() => {})
    if (ids.orgB) await prisma.organization.delete({ where: { id: ids.orgB } }).catch(() => {})
  })

  test('org sees its own templates (any visibility) + other orgs\' global, never other orgs\' org-visibility', async () => {
    const { own, global } = await fetchCatalogueRows(ids.orgA)
    const ownIds = own.map((r: any) => r.id).sort()
    const globalIds = global.map((r: any) => r.id)
    assert.deepEqual(ownIds, [ids.aGlobal, ids.aOrg].sort(), 'own = both of orgA\'s rows regardless of visibility')
    assert.ok(globalIds.includes(ids.bGlobal), 'orgB\'s global template is visible')
    assert.ok(!globalIds.includes(ids.bOrg), 'orgB\'s org-visibility template must NOT leak')
    assert.ok(!globalIds.includes(ids.aOrg) && !globalIds.includes(ids.aGlobal), 'own rows are not double-counted in the global slice')
  })
}
