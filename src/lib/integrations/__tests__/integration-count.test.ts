import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  MIN_INTEGRATIONS_FOR_TEMPLATES,
  meetsTemplateGate,
  distinctProviderKeys,
} from '../integration-count'

// ── Pure gate + dedupe logic (no DB) ─────────────────────────────────────────

test('MIN_INTEGRATIONS_FOR_TEMPLATES is 3', () => {
  assert.equal(MIN_INTEGRATIONS_FOR_TEMPLATES, 3)
})

test('meetsTemplateGate is false below the threshold, true at or above it', () => {
  assert.equal(meetsTemplateGate(0), false)
  assert.equal(meetsTemplateGate(2), false)
  assert.equal(meetsTemplateGate(3), true)
  assert.equal(meetsTemplateGate(4), true)
})

test('distinctProviderKeys dedupes the same provider seen via two planes', () => {
  // 'slack' via Nango + 'SLACK' via Klavis is one integration.
  assert.deepEqual(distinctProviderKeys([{ key: 'slack' }, { key: 'SLACK' }, { key: 'gmail' }]), [
    'slack',
    'gmail',
  ])
})

test('distinctProviderKeys keeps plane-prefixed servers distinct', () => {
  const keys = distinctProviderKeys([{ key: 'mcp:a' }, { key: 'mcp:b' }, { key: 'strata:gmail' }])
  assert.equal(keys.length, 3)
})

test('distinctProviderKeys on empty input is empty', () => {
  assert.deepEqual(distinctProviderKeys([]), [])
})

// ── DB-gated fixtures (run only under TEST_DATABASE_URL, like sibling DB tests) ─

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let countConnectedIntegrations: (organizationId: string, userId: string) => Promise<number>
  let seedTestOrg: (p: any) => Promise<{ organizationId: string; userId: string; cleanup: () => Promise<void> }>

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ countConnectedIntegrations } = await import('../integration-count'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
  })

  // A fresh org per case so connected planes never bleed across tests.
  const withOrg = async (
    fn: (ctx: { organizationId: string; userId: string }) => Promise<void>,
  ): Promise<void> => {
    const seeded = await seedTestOrg(prisma)
    try {
      await fn({ organizationId: seeded.organizationId, userId: seeded.userId })
    } finally {
      await seeded.cleanup()
    }
  }

  const nango = (organizationId: string, providerConfigKey: string) =>
    prisma.nangoConnection.create({
      data: {
        organizationId,
        connectionId: `${providerConfigKey}-${crypto.randomUUID()}`,
        providerConfigKey,
        status: 'connected',
      },
    })

  const klavis = (organizationId: string, userId: string, agentType: string) =>
    prisma.mCPAgent.create({
      data: {
        organizationId,
        userId,
        name: agentType,
        agentType,
        mcpServerUrl: 'https://example.test/mcp',
        isActive: true,
      },
    })

  test('0 planes → 0 connected', async () => {
    await withOrg(async ({ organizationId, userId }) => {
      assert.equal(await countConnectedIntegrations(organizationId, userId), 0)
    })
  })

  test('same provider via 2 planes → counts once', async () => {
    await withOrg(async ({ organizationId, userId }) => {
      await nango(organizationId, 'slack') // → key 'slack'
      await klavis(organizationId, userId, 'SLACK') // → key 'slack'
      assert.equal(await countConnectedIntegrations(organizationId, userId), 1)
    })
  })

  test('3 distinct providers → 3, meetsGate true', async () => {
    await withOrg(async ({ organizationId, userId }) => {
      await nango(organizationId, 'slack')
      await nango(organizationId, 'gmail')
      await klavis(organizationId, userId, 'GITHUB')
      const count = await countConnectedIntegrations(organizationId, userId)
      assert.equal(count, 3)
      assert.equal(meetsTemplateGate(count), true)
    })
  })

  test('2 distinct providers → meetsGate false', async () => {
    await withOrg(async ({ organizationId, userId }) => {
      await nango(organizationId, 'slack')
      await nango(organizationId, 'gmail')
      const count = await countConnectedIntegrations(organizationId, userId)
      assert.equal(count, 2)
      assert.equal(meetsTemplateGate(count), false)
    })
  })
}
