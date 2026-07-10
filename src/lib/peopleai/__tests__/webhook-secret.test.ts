import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ws-r3-test-key'

test('mintWebhookSecret returns a distinct high-entropy token each call', async () => {
  const { mintWebhookSecret } = await import('../webhook-secret')
  const a = mintWebhookSecret()
  const b = mintWebhookSecret()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let ensureOrgWebhookSecret: any
  let orgWebhookSecret: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ensureOrgWebhookSecret, orgWebhookSecret } = await import('../webhook-secret'))
    const org = await prisma.organization.create({ data: { name: 'Whs', slug: `whs-${Date.now()}` } })
    ids.org = org.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('ensureOrgWebhookSecret mints once and is stable across calls', async () => {
    const first = await ensureOrgWebhookSecret(ids.org)
    const second = await ensureOrgWebhookSecret(ids.org)
    assert.equal(first, second)
    const row = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.ok(row.peopleAiWebhookSecret)
    assert.notEqual(row.peopleAiWebhookSecret, first) // stored encrypted, not plaintext
  })

  test('orgWebhookSecret returns the plaintext, or null when unset', async () => {
    assert.equal(await orgWebhookSecret(ids.org), await ensureOrgWebhookSecret(ids.org))
    const bare = await prisma.organization.create({ data: { name: 'Whs2', slug: `whs2-${Date.now()}` } })
    assert.equal(await orgWebhookSecret(bare.id), null)
    await prisma.organization.delete({ where: { id: bare.id } })
  })
}
