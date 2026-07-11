import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let createTemplate: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ createTemplate } = await import('../create-template'))
    const org = await prisma.organization.create({ data: { name: 'tmpl-create Org', slug: `tmpl-create-${Date.now()}` } })
    ids.org = org.id
    // A User is required by the AgentTemplate.userId FK. Mirror the org+user
    // seeding used by src/app/api/__tests__/route-smoke.test.ts for the auth seam.
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `tmpl-create-${Date.now()}@example.com`, name: 'Tmpl Creator', organizationId: org.id } })
    ids.user = user.id
  })

  after(async () => {
    if (ids.org) await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('createTemplate defaults to source=user, visibility=org', async () => {
    const t = await createTemplate({ organizationId: ids.org, userId: ids.user, name: 'Default T', category: 'Sales', configuration: { instructions: 'x' } })
    assert.equal(t.source, 'user')
    assert.equal(t.visibility, 'org')
    assert.equal(t.type, 'Sales')
    assert.equal(t.organizationId, ids.org)
  })

  test('createTemplate honors an explicit ai_generated/org (the C path) and global', async () => {
    const ai = await createTemplate({ organizationId: ids.org, userId: ids.user, name: 'AI T', category: 'Ops', configuration: { instructions: 'y' }, source: 'ai_generated', visibility: 'org' })
    assert.equal(ai.source, 'ai_generated')
    assert.equal(ai.visibility, 'org')
    const pub = await createTemplate({ organizationId: ids.org, userId: ids.user, name: 'Pub T', category: 'Ops', configuration: { instructions: 'z' }, visibility: 'global' })
    assert.equal(pub.visibility, 'global')
    assert.equal(pub.source, 'user')
  })
}
