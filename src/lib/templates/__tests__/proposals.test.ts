import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  openProposalsWhere,
  listOpenProposals,
  getProposal,
  writeProposals,
  markAccepted,
  markDismissed,
  stampCreatedTemplate,
  reopenUnfulfilled,
} from '../proposals'

// --- Pure (no DB): the open-queue filter shape. Runs in every environment. ---
test('openProposalsWhere: org+status only without a userId', () => {
  assert.deepEqual(openProposalsWhere('org-1'), { organizationId: 'org-1', status: 'open' })
})

test('openProposalsWhere: a userId narrows to own + org-wide (null), org stays top-level', () => {
  const where = openProposalsWhere('org-1', 'rep-9')
  assert.equal(where.organizationId, 'org-1', 'org must stay a top-level key (tenant guard)')
  assert.equal(where.status, 'open')
  assert.deepEqual(where.OR, [{ userId: 'rep-9' }, { userId: null }])
})

test('openProposalsWhere: a null userId behaves like "not provided" (no OR narrowing)', () => {
  assert.equal(openProposalsWhere('org-1', null).OR, undefined)
})

// --- DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests. ---
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seq = 0
  const mkOrg = (label: string) =>
    prisma.organization.create({
      data: { name: label, slug: `${label}-${Date.now()}-${seq++}` },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
  })

  after(async () => {
    // Each test owns and deletes its orgs (cascade cleans proposals); nothing global to tear down.
  })

  test('writeProposals → listOpenProposals returns open rows; a userId narrows to own + org-wide', async () => {
    const org = await mkOrg('prop-list')
    try {
      const n = await writeProposals(org.id, [
        { userId: 'rep-1', title: 'For rep 1', rationale: 'r', kind: 'agent_template', configuration: { a: 1 }, sourceEvidence: { signal: 'x' } },
        { userId: null, title: 'Org wide', rationale: 'r', kind: 'flow_template', configuration: {}, sourceEvidence: {} },
        { userId: 'rep-2', title: 'For rep 2', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} },
      ])
      assert.equal(n, 3)

      const all = await listOpenProposals(org.id)
      assert.equal(all.length, 3, 'no userId → every open proposal for the org')

      const forRep1 = await listOpenProposals(org.id, 'rep-1')
      assert.deepEqual(
        forRep1.map((p) => p.title).sort(),
        ['For rep 1', 'Org wide'],
        "rep-1 sees own + org-wide, not rep-2's",
      )
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('listOpenProposals returns newest-first', async () => {
    const org = await mkOrg('prop-order')
    try {
      const base = { organizationId: org.id, rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} }
      await prisma.templateProposal.create({ data: { ...base, title: 'older', createdAt: new Date('2020-01-01T00:00:00Z') } })
      await prisma.templateProposal.create({ data: { ...base, title: 'newer', createdAt: new Date('2020-06-01T00:00:00Z') } })
      const list = await listOpenProposals(org.id)
      assert.deepEqual(list.map((p) => p.title), ['newer', 'older'])
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('markAccepted stamps createdTemplateId, flips status, leaves the open queue; idempotent', async () => {
    const org = await mkOrg('prop-accept')
    try {
      await writeProposals(org.id, [{ title: 'T', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} }])
      const [p] = await listOpenProposals(org.id)

      const res = await markAccepted(p.id, org.id, 'tmpl-123')
      assert.equal(res.count, 1)

      const got = await getProposal(p.id, org.id)
      assert.ok(got)
      assert.equal(got.status, 'accepted')
      assert.equal(got.createdTemplateId, 'tmpl-123')
      assert.equal((await listOpenProposals(org.id)).length, 0, 'accepted disappears from open')

      // Idempotent-safe: a second accept is a no-op, does not re-stamp.
      const again = await markAccepted(p.id, org.id, 'tmpl-999')
      assert.equal(again.count, 0)
      const still = await getProposal(p.id, org.id)
      assert.ok(still)
      assert.equal(still.createdTemplateId, 'tmpl-123')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('markDismissed is terminal and idempotent', async () => {
    const org = await mkOrg('prop-dismiss')
    try {
      await writeProposals(org.id, [{ title: 'T', rationale: 'r', kind: 'process_improvement', configuration: {}, sourceEvidence: {} }])
      const [p] = await listOpenProposals(org.id)

      assert.equal((await markDismissed(p.id, org.id)).count, 1)
      const got = await getProposal(p.id, org.id)
      assert.ok(got)
      assert.equal(got.status, 'dismissed')
      assert.equal((await listOpenProposals(org.id)).length, 0)

      assert.equal((await markDismissed(p.id, org.id)).count, 0, 'terminal: second dismiss is a no-op')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('claim-first accept: a concurrent second claim is a no-op, so no duplicate template', async () => {
    // Mirrors the accept route's atomic claim (markAccepted with no template id
    // BEFORE createTemplate). Two racing accepts must not both proceed to create.
    const org = await mkOrg('prop-claim')
    try {
      await writeProposals(org.id, [{ title: 'T', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} }])
      const [p] = await listOpenProposals(org.id)

      const first = await markAccepted(p.id, org.id) // claim, id stamped later
      const second = await markAccepted(p.id, org.id) // racing accept
      assert.equal(first.count, 1, 'first claim wins')
      assert.equal(second.count, 0, 'second claim is a no-op — the duplicate-create guard')

      // Winner stamps the created id; the loser would return this idempotently.
      await stampCreatedTemplate(p.id, org.id, 'tmpl-abc')
      const got = await getProposal(p.id, org.id)
      assert.equal(got?.status, 'accepted')
      assert.equal(got?.createdTemplateId, 'tmpl-abc')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('reopenUnfulfilled returns a claimed-but-unstamped proposal to the queue; never a fulfilled one', async () => {
    const org = await mkOrg('prop-reopen')
    try {
      await writeProposals(org.id, [
        { title: 'Unfulfilled', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} },
        { title: 'Fulfilled', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} },
      ])
      const open = await listOpenProposals(org.id)
      const unfulfilled = open.find((p) => p.title === 'Unfulfilled')!
      const fulfilled = open.find((p) => p.title === 'Fulfilled')!

      // Unfulfilled: claimed (accepted) but template creation "threw" before stamping.
      await markAccepted(unfulfilled.id, org.id)
      // Fulfilled: claimed AND stamped.
      await markAccepted(fulfilled.id, org.id)
      await stampCreatedTemplate(fulfilled.id, org.id, 'tmpl-xyz')

      assert.equal((await reopenUnfulfilled(unfulfilled.id, org.id)).count, 1, 'unstamped accept reopens')
      assert.equal((await getProposal(unfulfilled.id, org.id))?.status, 'open')

      assert.equal((await reopenUnfulfilled(fulfilled.id, org.id)).count, 0, 'a stamped accept never reopens')
      assert.equal((await getProposal(fulfilled.id, org.id))?.status, 'accepted')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('another org can neither read nor mutate a proposal (tenant isolation)', async () => {
    const orgA = await mkOrg('prop-iso-a')
    const orgB = await mkOrg('prop-iso-b')
    try {
      await writeProposals(orgA.id, [{ title: 'A only', rationale: 'r', kind: 'agent_template', configuration: {}, sourceEvidence: {} }])
      const [p] = await listOpenProposals(orgA.id)

      // Read isolation.
      assert.equal(await getProposal(p.id, orgB.id), null)
      assert.equal((await listOpenProposals(orgB.id)).length, 0)

      // Mutate isolation: orgB's accept/dismiss is a no-op; orgA's row is untouched.
      assert.equal((await markAccepted(p.id, orgB.id, 'x')).count, 0)
      assert.equal((await markDismissed(p.id, orgB.id)).count, 0)
      const untouched = await getProposal(p.id, orgA.id)
      assert.ok(untouched)
      assert.equal(untouched.status, 'open')
      assert.equal(untouched.createdTemplateId, null)
    } finally {
      await prisma.organization.delete({ where: { id: orgA.id } }).catch(() => {})
      await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => {})
    }
  })
}
