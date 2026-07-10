# Remediation WS-R4: Org-Deletion Completeness + Neo4j Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting an organization actually deletes everything it owns (DB rows via complete FK cascades, external Klavis/Nango resources, Neo4j graph nodes), and the daily retention job prunes Neo4j in lockstep with Postgres so deleted runs/signals can't resurface in RAG context.

**Architecture:** (1) One schema migration adds the missing `Organization` FK (with `onDelete: Cascade`) to the five root models that have `organizationId` but no relation — `Flow`, `CustomSignal`, `PushSubscription`, `KnowledgeDocument`, `SharedSkill` — with orphan-row cleanup SQL prepended so the constraints can apply on existing data. Child models (`FlowRun`→`FlowRunStep`, `KnowledgeChunk`, `AgentConnector`, `AgentChatMessage/Session`) already cascade from these roots or from `AgentTask`, so the five root FKs complete every chain. (2) A new `teardownOrganization()` helper deprovisions external resources (Klavis server instances, Nango connections), clears the org's graph nodes (implementing the missing `Neo4jGraphStore.clear`), then deletes the org row — and replaces the bare `organization.delete` in the People.ai solo-org cleanup. (3) The retention cron collects the ids it's about to delete, groups them by org, and best-effort deletes the corresponding `run:`/`signal:` graph nodes via the existing `deleteNodes` store method.

**Tech Stack:** Prisma migration with hand-edited SQL (orphan cleanup + FK adds), Neo4j Cypher (`DETACH DELETE` by org), existing Klavis/Nango client helpers, node:test.

**Scope Note:** Out of scope (audit follow-ups, not in this workstream's approved item): a user-facing org-deletion API route (product decision — the teardown helper is built for when one exists); user-offboarding FK changes (`AgentExecution.userId` Cascade→SetNull needs a nullable-column migration; `deleteByOwner` stays unwired); PII redaction lifecycles. SharedSkill decision made here: an org's community skills ARE cascade-deleted with the org — an orphaned skill has no owner able to edit or retire it, and the model's own comment scopes writes to "the creator's org".

## Global Constraints

- Code style: single quotes, NO semicolons, 2-space indent.
- ONE schema migration (Task 1). Generate with `prisma migrate dev` against a THROWAWAY local DB (never a real env), then hand-edit the SQL to prepend orphan cleanup. CI's migrate-from-zero + drift jobs validate it — the edited SQL must keep `prisma migrate diff` clean (cleanup `DELETE`s are data-only, no schema drift).
- DB-backed tests self-skip without `TEST_DATABASE_URL`.
- External teardown (Klavis/Nango/Neo4j) is BEST-EFFORT: each leg try/catch-wrapped with `captureError`; a failed external call must never abort the DB deletion or the other legs. When the relevant env (KLAVIS_API_KEY / Nango key / NEO4J_*) is unset, each leg no-ops cleanly.
- New graph deletions guard on `graphRagPersistent()` exactly like the existing removal helpers.
- Tenant guard rules apply: org-teardown and retention sweeps are system paths → `systemPrisma` with justification comments; anything org-scoped stays on `prisma`.
- No new dependencies. Commits direct to `main`; push only at the final task's gate (isolated-worktree: typecheck/lint/test, ci_repro migrate-from-zero + DB suite + build).
- Concurrent-session caveat: another session may hold uncommitted WIP in flows UI files — its typecheck/lint/test failures are not yours; commit only files you changed.

---

### Task 1: Complete the org cascade — five root FKs + orphan cleanup migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_org_cascade_completeness/migration.sql` (generated, then hand-edited)
- Test: `src/lib/__tests__/org-cascade.test.ts`

**Interfaces:**
- Consumes: existing schema relations (verified: `FlowVersion`, `FlowRun`→`Flow` cascade, `FlowRunStep`→`FlowRun` cascade, `KnowledgeChunk`→`KnowledgeDocument` cascade, `AgentConnector`/`AgentChatMessage`/`AgentChatSession`→`AgentTask` cascade, `AgentTask`→`Organization` cascade already exist).
- Produces: `Organization` gains back-relations `flows Flow[]`, `customSignals CustomSignal[]`, `pushSubscriptions PushSubscription[]`, `knowledgeDocuments KnowledgeDocument[]`, `sharedSkills SharedSkill[]`; each of the five models gains `organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)`. Task 2 relies on `prisma.organization.delete` now cascading these chains.

- [ ] **Step 1: Write the failing DB test**

Create `src/lib/__tests__/org-cascade.test.ts` — DB-gated (standard `if (TEST_DB)` pattern, dynamic-import `prisma` from `@/lib/prisma`). Seed one org with: a `Flow` (+ one `FlowRun` + one `FlowRunStep` + one `FlowVersion`), a `CustomSignal`, a `PushSubscription` (fill its required fields per schema — read the model first), a `KnowledgeDocument` (+ one `KnowledgeChunk`), a `SharedSkill`. Then `prisma.organization.delete({ where: { id } })` and assert EVERY seeded row is gone (`findUnique` → null for each, using `systemPrisma`-style unscoped lookups is fine inside the test via the imported client — but note the guard: use `findUnique({ where: { id, organizationId } })`-shaped queries or query counts by org). Also assert an UNRELATED org's `Flow` survives (no over-delete). Before the migration exists this test must FAIL at the delete (FK-less rows survive) — capture that as RED evidence; after the migration it passes.

- [ ] **Step 2: Schema edits**

For each of the five models add the relation line after its `organizationId` field, e.g. for `Flow`:

```prisma
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
```

And add the five back-relation arrays to `Organization`'s relation list. `SharedSkill` gets a one-line comment: `// Org deletion cascades community skills — an orphaned skill has no owner able to edit or retire it.`

- [ ] **Step 3: Generate + hand-edit the migration**

```bash
psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS ws_r4_migrate' -c 'CREATE DATABASE ws_r4_migrate'
DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/ws_r4_migrate DIRECT_URL=postgresql://james.mcdaniel@localhost:5432/ws_r4_migrate npx prisma migrate dev --name org_cascade_completeness
```

Then EDIT the generated `migration.sql`: BEFORE each `ADD CONSTRAINT`, prepend a cleanup `DELETE` for rows whose org no longer exists, in child-before-parent order so the deletes themselves don't violate existing FKs. Use the actual `@@map` table names (read the schema: `flows`, `flow_runs`, `flow_run_steps`, `custom_signals`, `push_subscriptions`, `knowledge_documents`, `knowledge_chunks`, plus SharedSkill's mapped name — check it):

```sql
-- Orphan cleanup: rows referencing organizations that no longer exist would
-- violate the new FKs. Child tables first (their own FKs cascade from the
-- roots, but a root row can be orphaned while its children reference IT, so
-- deleting roots cascades children — one DELETE per new-FK root suffices).
DELETE FROM "flows" WHERE "organizationId" NOT IN (SELECT "id" FROM "organizations");
DELETE FROM "custom_signals" WHERE "organizationId" NOT IN (SELECT "id" FROM "organizations");
DELETE FROM "push_subscriptions" WHERE "organizationId" NOT IN (SELECT "id" FROM "organizations");
DELETE FROM "knowledge_documents" WHERE "organizationId" NOT IN (SELECT "id" FROM "organizations");
DELETE FROM "shared_skills" WHERE "organizationId" NOT IN (SELECT "id" FROM "organizations");
```

(Adjust quoted table/column names to the real mapped names — verify each against the schema's `@@map` and field names before writing.) Re-apply to the throwaway DB (`prisma migrate reset` semantics via drop/recreate + `migrate deploy`) to prove the edited SQL runs from zero. Drop the throwaway DB.

- [ ] **Step 4: RED→GREEN + gate + commit**

Run the org-cascade test against a fresh throwaway DB (migrate deploy first): PASS now. `npm run typecheck && npm run lint && npm test`.

```bash
git add prisma/schema.prisma prisma/migrations src/lib/__tests__/org-cascade.test.ts
git commit -m "fix(db): org deletion cascades flows, custom signals, push subscriptions, knowledge, shared skills — orphan cleanup + FKs"
```

---

### Task 2: Organization teardown — external resources + graph + row

**Files:**
- Create: `src/lib/org-teardown.ts`
- Modify: `src/lib/rag/neo4j-store.ts` (implement `clear(organizationId)`)
- Modify: `src/lib/rag/store.ts` only if needed (interface already declares `clear?`)
- Modify: `src/lib/peopleai/connect-service.ts` (solo-org delete uses the teardown helper)
- Test: `src/lib/__tests__/org-teardown.test.ts`; extend `src/lib/rag/__tests__/store-contract.test.ts` for `clear` if the contract suite covers MemoryGraphStore (read it first)

**Interfaces:**
- Consumes: `klavisClient.deleteServerInstance(instanceId)` (src/lib/mcp/klavis-client.ts:69), `getNangoClient().deleteConnection(integrationId, connectionId)` (src/lib/nango), `getGraphRagStore()` + `graphRagPersistent()` (src/lib/rag/get-store.ts), `systemPrisma`.
- Produces: `teardownOrganization(organizationId: string): Promise<{ klavis: number; nango: number; graphCleared: boolean }>` — deprovisions externals best-effort, clears graph, then deletes the org row (cascading Task 1's completed chains). `Neo4jGraphStore.clear(organizationId)` implemented.

- [ ] **Step 1: Implement `Neo4jGraphStore.clear`**

In `src/lib/rag/neo4j-store.ts`, mirroring `deleteByOwner`'s shape:

```ts
  async clear(organizationId: string): Promise<void> {
    const session = await this.session()
    try {
      await session.run('MATCH (e:Entity) WHERE e.organizationId = $org DETACH DELETE e', { org: organizationId })
    } finally {
      await session.close()
    }
  }
```

Adapt to the file's actual session-acquisition idiom (read it first — the driver/session helper may differ). If `store-contract.test.ts` runs contract assertions against MemoryGraphStore, add a `clear` contract case (seed two orgs' nodes, clear one, other survives).

- [ ] **Step 2: Write failing teardown test**

`src/lib/__tests__/org-teardown.test.ts`, DB-gated. With KLAVIS_API_KEY/NANGO_SECRET_KEY/NEO4J_* all unset (assert so, or delete from process.env at test top), seed an org with an `MCPAgent` (metadata.instanceId set), a `NangoConnection`, and a `Flow`; call `teardownOrganization(org.id)`; assert: returns counts (`klavis: 0` or count-attempted — pin whatever the implementation contract is: attempted-count 0 because env unset → leg no-ops), org row gone, cascaded rows gone (MCPAgent, NangoConnection, Flow). This proves the no-external-env path deletes cleanly.

- [ ] **Step 3: Implement the helper**

`src/lib/org-teardown.ts`:

```ts
/**
 * Complete organization teardown: external resources first (best-effort),
 * then the graph, then the org row — whose FK cascades (completed in WS-R4
 * Task 1) delete every owned row. Each external leg is isolated: a Klavis
 * outage must not strand Nango connections or block the DB delete.
 */

import { systemPrisma } from '@/lib/prisma'
import { captureError } from '@/lib/observability/sentry'
import { graphRagPersistent, getGraphRagStore } from '@/lib/rag/get-store'

export async function teardownOrganization(organizationId: string): Promise<{ klavis: number; nango: number; graphCleared: boolean }> {
  let klavis = 0
  let nango = 0
  let graphCleared = false

  // systemPrisma: org teardown enumerates the org's own rows by org id — the
  // guard's org-scope requirement is satisfied semantically but these run
  // outside any authenticated request context.
  try {
    if (process.env.KLAVIS_API_KEY) {
      const { klavisClient } = await import('@/lib/mcp/klavis-client')
      const mcpAgents = await systemPrisma.mCPAgent.findMany({ where: { organizationId } })
      for (const agent of mcpAgents) {
        const instanceId = (agent.metadata as { instanceId?: string } | null)?.instanceId
        if (!instanceId) continue
        try {
          await klavisClient.deleteServerInstance(instanceId)
          klavis += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.klavis', organizationId, instanceId })
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.klavisLeg', organizationId })
  }

  try {
    if (process.env.NANGO_SECRET_KEY) {
      const { getNangoClient } = await import('@/lib/nango/client')
      const client = getNangoClient()
      const connections = await systemPrisma.nangoConnection.findMany({ where: { organizationId } })
      for (const connection of connections) {
        try {
          await client.deleteConnection(connection.integrationId, connection.connectionId)
          nango += 1
        } catch (error) {
          captureError(error, { source: 'orgTeardown.nango', organizationId, connectionId: connection.connectionId })
        }
      }
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.nangoLeg', organizationId })
  }

  try {
    if (graphRagPersistent()) {
      await getGraphRagStore().clear?.(organizationId)
      graphCleared = true
    }
  } catch (error) {
    captureError(error, { source: 'orgTeardown.graph', organizationId })
  }

  await systemPrisma.organization.delete({ where: { id: organizationId } })
  return { klavis, nango, graphCleared }
}
```

Adapt import names to the actual klavis/nango module exports (read them first — `klavisClient` may be a factory or class instance; `NangoConnection` field names for integration/connection ids must match the schema). Verify the Prisma client property casing for `MCPAgent` (`systemPrisma.mCPAgent` is Prisma's default casing for that model name — confirm from the generated client or an existing call site).

- [ ] **Step 4: Wire into the solo-org cleanup**

In `src/lib/peopleai/connect-service.ts` (~line 155), replace the bare delete:

```ts
    if (agentCount === 0) {
      // Full teardown, not a bare row delete: the solo org may still hold
      // connections/flows whose external resources would otherwise leak.
      const { teardownOrganization } = await import('@/lib/org-teardown')
      await teardownOrganization(input.organizationId).catch(() => undefined)
    }
```

Keep the existing `.catch` swallow (connect must not fail on cleanup) — note the swallow now happens AFTER internal best-effort reporting inside the helper.

- [ ] **Step 5: RED→GREEN + gate + commit**

Teardown test passes against a throwaway DB. Full gate.

```bash
git add src/lib/org-teardown.ts src/lib/__tests__/org-teardown.test.ts src/lib/rag/neo4j-store.ts src/lib/rag/__tests__/store-contract.test.ts src/lib/peopleai/connect-service.ts
git commit -m "feat(db): organization teardown deprovisions Klavis/Nango, clears the graph, then cascades the row"
```

---

### Task 3: Retention prunes Neo4j in lockstep with Postgres

**Files:**
- Modify: `src/lib/rag/indexer.ts` (new bulk removal helper)
- Modify: `src/app/api/cron/retention/route.ts`
- Test: `src/lib/rag/__tests__/indexer.test.ts` (extend); retention wiring verified via a focused DB test `src/app/api/cron/__tests__/retention-graph.test.ts` only if the route's logic can be exercised without HTTP scaffolding — otherwise unit-test the helper and keep route wiring reviewable by reading (state which you did in your report).

**Interfaces:**
- Consumes: `getGraphRagStore().deleteNodes(organizationId, ids)`, `graphRagPersistent()`, the `nid` id conventions (`run:${id}`, `signal:${id}`) internal to indexer.ts.
- Produces: `removeRetiredFromGraph(groups: Array<{ organizationId: string; executionIds: string[]; signalIds: string[] }>): Promise<void>` exported from `src/lib/rag/indexer.ts` — best-effort, no-ops without Neo4j.

- [ ] **Step 1: Failing unit test**

Extend `src/lib/rag/__tests__/indexer.test.ts` (read its existing gate/no-op test style first): `removeRetiredFromGraph` no-ops cleanly when `graphRagPersistent()` is false (call it with a non-empty group; assert it resolves without touching anything — same pattern the file uses for the index no-op tests).

- [ ] **Step 2: Implement the helper**

In `src/lib/rag/indexer.ts`, alongside `removeExecutionFromGraph`:

```ts
/**
 * Bulk graph cleanup for the retention job: delete the run:/signal: nodes for
 * rows Postgres is about to (or just did) prune, grouped per org because the
 * store API scopes deletes by organizationId. Best-effort — retention must
 * never fail on graph cleanup; a missed node is re-swept the next day only if
 * ids are still known, so callers should delete graph-first or tolerate loss.
 */
export async function removeRetiredFromGraph(
  groups: Array<{ organizationId: string; executionIds: string[]; signalIds: string[] }>,
): Promise<void> {
  if (!graphRagPersistent()) return
  const store = getGraphRagStore()
  for (const group of groups) {
    const ids = [...group.executionIds.map((id) => nid.run(id)), ...group.signalIds.map((id) => nid.signal(id))]
    if (ids.length === 0) continue
    try {
      await store.deleteNodes(group.organizationId, ids)
    } catch (error) {
      warn('graph retention cleanup failed', { organizationId: group.organizationId, count: ids.length, error })
    }
  }
}
```

Match the file's actual internal names (`nid`, `warn`, store accessor) — read it first.

- [ ] **Step 3: Wire into retention**

In `src/app/api/cron/retention/route.ts`: the route already does `findMany` (ids) before each `deleteMany`. Extend the two `findMany` selects to include `organizationId`, build the per-org groups from BOTH lists (executions + signals merged by org), and call `removeRetiredFromGraph(groups)` BEFORE the Postgres `deleteMany`s (graph-first per the helper's comment — once Postgres rows are gone the ids are unrecoverable), wrapped so a graph failure never aborts the sweep:

```ts
    // Graph parity: prune the run:/signal: nodes for the rows this sweep is
    // about to delete — graph-first, because after the Postgres delete the
    // ids are gone and a missed node would linger forever (audit: deleted
    // PII resurfacing in RAG context).
    try {
      await removeRetiredFromGraph(groups)
    } catch (error) {
      apiLogger.error('cron/retention: graph cleanup failed', { error: capError(error) })
    }
```

(Use the file's existing error-capping/logging idioms; import the helper.)

- [ ] **Step 4: Gate + commit**

```bash
git add src/lib/rag/indexer.ts src/lib/rag/__tests__/indexer.test.ts src/app/api/cron/retention/route.ts
git commit -m "fix(rag): retention prunes run/signal graph nodes in lockstep with Postgres — deleted data can't resurface in RAG"
```

---

### Task 4: Docs, CI-mode gate, push, final review

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `.superpowers/sdd/progress.md` (ledger, untracked)

- [ ] **Step 1: ARCHITECTURE.md**

In the Core Data section (read the file for the right spot), append:

```markdown
Organization deletion is complete: every org-owned model cascades via FK (WS-R4 closed the gaps — flows, custom signals, push subscriptions, knowledge, shared skills), and `teardownOrganization` (`src/lib/org-teardown.ts`) deprovisions external Klavis/Nango resources and clears the org's Neo4j nodes before deleting the row. The daily retention cron prunes `run:`/`signal:` graph nodes in lockstep with the Postgres rows it deletes.
```

- [ ] **Step 2: Isolated-worktree gate** — same recipe as WS-R2/R3 Task-final (worktree at HEAD, symlinked node_modules, typecheck/lint/test; recreate `ci_repro`, `migrate deploy` from zero — this validates the hand-edited migration — DB-backed `npm test`, `npm run build`).

- [ ] **Step 3: Push + CI green** (`git push origin main`, poll the Actions API for the pushed SHA).

- [ ] **Step 4: Final whole-workstream review** (controller dispatches; most capable model; triage open minors).
