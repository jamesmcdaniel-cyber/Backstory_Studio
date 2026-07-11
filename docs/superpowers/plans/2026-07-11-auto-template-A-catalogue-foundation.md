# Auto-Template Sub-Project A — Catalogue Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the template catalogue org-aware — tag every template with `source` + `visibility`, scope the read to the org's own templates plus the shared-global library, order the org's own catalogue first, and expose a single `createTemplate()` writer the later generation engine (sub-project C) will call.

**Architecture:** Two additive columns on `AgentTemplate` (`source`, `visibility`) + a new index. A `src/lib/templates/` module owns the write helper (`createTemplate`), the row serializer, the pure ranking comparator, and the catalogue fetch (own via the tenant-guarded client, the cross-org `global` slice via `systemPrisma`). The `agent-templates` route becomes a thin caller of that module. No behavior forks a retriever; the existing built-in templates stay static code.

**Tech Stack:** TypeScript (single quotes, no semicolons, 2-space indent), Prisma/Postgres, Zod, `node:test` + `node:assert/strict`, `tsx`. Migrations are hand-authored raw-SQL folders applied via `prisma migrate deploy` / `scripts/vercel-migrate.mjs` at deploy.

## Global Constraints

- Code style: single quotes, no semicolons, 2-space indent (match surrounding files).
- Tenant safety: every query carries `organizationId`. The ONLY cross-org read is the `visibility = 'global'` community slice — it uses `systemPrisma` with a one-line justification comment; the org's own rows go through the tenant-guarded `prisma` client.
- Migrations are additive only (new columns default-valued, new index) — no destructive change. Name the new migration folder with a timestamp AFTER the latest existing one (`20260710193654_pgvector_embeddings`), e.g. `20260711120000_agent_template_source_visibility`.
- `source ∈ {'user','ai_generated'}` (default `'user'`); `visibility ∈ {'org','global'}` (default `'org'`). Existing rows backfill to `visibility = 'global'` (preserve today's community-library behavior).
- Catalogue order: org-owned first (`ai_generated` above `user`), then other-orgs' `global`, then built-ins.
- No raw `{{token}}` syntax in any user-facing UI string.
- Local env has no DB/Supabase vars — DB-gated tests skip locally and run in CI; pure tests + typecheck are the local gate. Do NOT run `npm run build` or the full `npm test` locally.

---

### Task 1: Schema migration — `source` + `visibility` + index

**Files:**
- Modify: `prisma/schema.prisma` (the `AgentTemplate` model, currently near line 479)
- Create: `prisma/migrations/20260711120000_agent_template_source_visibility/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentTemplate.source: string` (default `'user'`) and `AgentTemplate.visibility: string` (default `'org'`) columns + a `(organizationId, visibility)` index, available on the generated Prisma client for Tasks 2–3.

- [ ] **Step 1: Add the two columns + index to the Prisma model**

In `prisma/schema.prisma`, edit the `AgentTemplate` model. Replace:

```prisma
  metadata       Json?
  userId         String
  organizationId String   @db.Uuid
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  executions   AgentExecution[]

  @@index([organizationId, isActive])
  @@map("agent_templates")
```

with:

```prisma
  metadata       Json?
  // Where the template came from: 'user' (hand-authored) or 'ai_generated'
  // (proposed by the auto-generation engine, sub-project C).
  source         String   @default("user")
  // 'org' = visible only to the owning org (default); 'global' = published to
  // the shared community library, readable cross-org. Existing rows are
  // backfilled to 'global' by the migration to preserve prior behavior.
  visibility     String   @default("org")
  userId         String
  organizationId String   @db.Uuid
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  executions   AgentExecution[]

  @@index([organizationId, isActive])
  @@index([organizationId, visibility])
  @@map("agent_templates")
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260711120000_agent_template_source_visibility/migration.sql` with exactly:

```sql
-- Add template provenance + visibility. Existing rows predate the feature and
-- were readable by every workspace (the old GET returned all orgs' rows), so
-- backfill them to 'global' to preserve that community-library behavior. New
-- rows default to 'org' (private to the creating org) and 'user' source.
ALTER TABLE "agent_templates" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "agent_templates" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'org';

-- One-time backfill: every row that exists at migration time is a pre-feature
-- community template → make it globally visible. (No effect on a fresh DB.)
UPDATE "agent_templates" SET "visibility" = 'global';

CREATE INDEX "agent_templates_organizationId_visibility_idx"
  ON "agent_templates"("organizationId", "visibility");
```

- [ ] **Step 3: Regenerate the Prisma client and validate**

Run: `npx prisma generate && npx prisma validate`
Expected: client regenerates without error; `The schema at prisma/schema.prisma is valid`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — the new `source`/`visibility` fields resolve on the `AgentTemplate` client type (no consumers yet, so this just confirms the schema compiles).

- [ ] **Step 5: Commit**

Note: there is no unit test for the migration — a fresh CI/test DB has no pre-existing rows, so the `UPDATE` backfill is a no-op there and is verified by inspection; the column defaults are exercised by Task 2's `createTemplate` test and the scoping test in Task 3.

```bash
git add prisma/schema.prisma prisma/migrations/20260711120000_agent_template_source_visibility
git commit -m "feat(templates): add source + visibility columns to AgentTemplate (backfill existing -> global)"
```

---

### Task 2: Write path — `createTemplate` helper, serializer, POST default org, PUT publish-to-global

**Files:**
- Create: `src/lib/templates/create-template.ts`
- Create: `src/lib/templates/catalogue.ts` (houses the moved `serializeTemplate`)
- Create: `src/lib/templates/__tests__/serialize.test.ts`
- Create: `src/lib/templates/__tests__/create-template.test.ts`
- Modify: `src/app/api/agent-templates/route.ts` (templateSchema, POST, PUT, remove the local `serializeTemplate`, import from the lib)
- Modify: `src/app/templates/page.tsx` (community dialog passes `visibility: 'global'`)

**Interfaces:**
- Consumes: `AgentTemplate.source`/`visibility` columns (Task 1).
- Produces:
  - `createTemplate(params: { organizationId: string; userId: string; name: string; category: string; description?: string; configuration: Record<string, unknown>; source?: 'user' | 'ai_generated'; visibility?: 'org' | 'global' }): Promise<AgentTemplate>` — the single writer; defaults `source: 'user'`, `visibility: 'org'`; maps `category` → the `type` column. **Sub-project C's proposal-approval path calls this with `source: 'ai_generated', visibility: 'org'`.**
  - `serializeTemplate(row: AgentTemplateRow, viewerOrgId?: string) => SerializedTemplate` — exported from `catalogue.ts`; output now includes `source` and `visibility` alongside the existing fields and the `mine` flag.

- [ ] **Step 1: Write the failing serializer test**

Create `src/lib/templates/__tests__/serialize.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeTemplate } from '../catalogue'

const row = {
  id: 't1',
  name: 'Renewal watcher',
  description: 'Watches renewals',
  type: 'Sales',
  configuration: { instructions: 'do it', integrations: ['salesforce'], skills: [], tags: ['renewal'], model: 'gpt-4o', authorName: 'Rep A' },
  source: 'ai_generated',
  visibility: 'org',
  organizationId: 'orgA',
}

test('serializeTemplate exposes source, visibility, and mine', () => {
  const out = serializeTemplate(row, 'orgA')
  assert.equal(out.source, 'ai_generated')
  assert.equal(out.visibility, 'org')
  assert.equal(out.mine, true)
  assert.equal(out.category, 'Sales')
  assert.equal(out.instructions, 'do it')
})

test('serializeTemplate marks mine=false for another org and defaults missing provenance', () => {
  const out = serializeTemplate({ ...row, source: undefined, visibility: undefined }, 'orgB')
  assert.equal(out.mine, false)
  assert.equal(out.source, 'user')      // defaults when absent
  assert.equal(out.visibility, 'org')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/templates/__tests__/serialize.test.ts`
Expected: FAIL — `Cannot find module '../catalogue'`.

- [ ] **Step 3: Create the catalogue module with the moved serializer**

Create `src/lib/templates/catalogue.ts`:

```ts
import type { AgentTemplate } from '@prisma/client'

/** The subset of an AgentTemplate row the serializer reads (row from DB or a test fixture). */
export type AgentTemplateRow = Pick<AgentTemplate, 'id' | 'name' | 'type' | 'organizationId'> & {
  description?: string | null
  configuration?: unknown
  source?: string | null
  visibility?: string | null
}

export interface SerializedTemplate {
  id: string
  name: string
  description: string
  category: string
  instructions: string
  integrations: string[]
  skills: string[]
  tags: string[]
  model: string
  exampleOutput: string
  icon: string
  allowSubagents: boolean
  custom: boolean
  authorName: string
  source: string
  visibility: string
  mine: boolean
}

/** Serialize a stored template row for the API. `mine` gates edit/delete in the UI. */
export function serializeTemplate(template: AgentTemplateRow, viewerOrgId?: string): SerializedTemplate {
  const config = template.configuration && typeof template.configuration === 'object' ? (template.configuration as Record<string, unknown>) : {}
  return {
    id: template.id,
    name: template.name,
    description: (template.description as string) || '',
    category: template.type,
    instructions: (config.instructions as string) || (template.description as string) || '',
    integrations: (config.integrations as string[]) || [],
    skills: (config.skills as string[]) || [],
    tags: (config.tags as string[]) || [],
    model: (config.model as string) || 'gpt-4o',
    exampleOutput: (config.exampleOutput as string) || '',
    icon: (config.icon as string) || '',
    allowSubagents: config.allowSubagents === true,
    custom: true,
    authorName: (config.authorName as string) || '',
    source: template.source ?? 'user',
    visibility: template.visibility ?? 'org',
    // Only the creating org may edit/delete a template.
    mine: Boolean(viewerOrgId) && template.organizationId === viewerOrgId,
  }
}
```

- [ ] **Step 4: Run the serializer test to verify it passes**

Run: `npx tsx --test src/lib/templates/__tests__/serialize.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing `createTemplate` test (DB-gated)**

Create `src/lib/templates/__tests__/create-template.test.ts`. It runs only when `TEST_DATABASE_URL` is set (skips locally, runs in CI):

```ts
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
    const user = await prisma.user.create({ data: { email: `tmpl-create-${Date.now()}@example.com`, name: 'Tmpl Creator', organizationId: org.id } })
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
```

- [ ] **Step 6: Run it to verify it fails (or skips locally)**

Run: `npx tsx --test src/lib/templates/__tests__/create-template.test.ts`
Expected (local, no `TEST_DATABASE_URL`): the file runs 0 tests (the `if (TEST_DB)` block is skipped) — that is expected; note it in your report. With a DB it FAILS on `Cannot find module '../create-template'`.

- [ ] **Step 7: Create the `createTemplate` helper**

Create `src/lib/templates/create-template.ts`:

```ts
import { prisma } from '@/lib/prisma'
import type { AgentTemplate } from '@prisma/client'

export interface CreateTemplateParams {
  organizationId: string
  userId: string
  name: string
  /** UI/domain category — stored in the `type` column. */
  category: string
  description?: string
  /** The configuration blob (instructions, integrations, skills, tags, model, …). */
  configuration: Record<string, unknown>
  source?: 'user' | 'ai_generated'
  visibility?: 'org' | 'global'
}

/**
 * The single writer for AgentTemplate rows. Both the manual POST route and the
 * auto-generation engine's proposal-approval path (sub-project C) go through
 * here so provenance (`source`) and scope (`visibility`) are always set.
 */
export async function createTemplate(params: CreateTemplateParams): Promise<AgentTemplate> {
  return prisma.agentTemplate.create({
    data: {
      name: params.name,
      description: params.description ?? '',
      type: params.category,
      configuration: params.configuration,
      userId: params.userId,
      organizationId: params.organizationId,
      source: params.source ?? 'user',
      visibility: params.visibility ?? 'org',
    },
  })
}
```

- [ ] **Step 8: Rewire the route's POST + PUT + templateSchema, and drop the local serializer**

In `src/app/api/agent-templates/route.ts`:

Replace the top imports + local `serializeTemplate` (lines 1–39) with:

```ts
import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { serializeTemplate } from '@/lib/templates/catalogue'
import { createTemplate } from '@/lib/templates/create-template'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('gpt-4o'),
  exampleOutput: z.string().optional(),
  icon: z.string().trim().max(8).optional(),
  allowSubagents: z.boolean().optional(),
  visibility: z.enum(['org', 'global']).optional(),
})
```

Replace the POST handler (currently lines 753–776) with:

```ts
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await createTemplate({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    name: data.name,
    category: data.category,
    description: data.description,
    // New templates default to org-private; the community "Publish" dialog
    // passes visibility: 'global' explicitly.
    visibility: data.visibility ?? 'org',
    configuration: {
      instructions: data.instructions,
      integrations: data.integrations,
      skills: data.skills,
      tags: data.tags,
      model: data.model,
      ...(data.exampleOutput ? { exampleOutput: data.exampleOutput } : {}),
      ...(data.icon ? { icon: data.icon } : {}),
      ...(data.allowSubagents ? { allowSubagents: true } : {}),
      authorName: auth.dbUser.name || auth.dbUser.email || '',
    },
  })
  return { success: true, template: serializeTemplate(template, auth.organizationId) }
})
```

In the PUT handler (currently lines 778–805), add `visibility` to the update so a template can be published to / unpublished from the community. Change the `update`'s `data` block to include, right after the `configuration: { ... }` object:

```ts
      ...(body.visibility !== undefined && { visibility: body.visibility }),
```

(The PUT body already merges `templateSchema.partial()`, which now carries the optional `visibility`, and the `where` stays `{ id, organizationId: auth.organizationId }` — so only the owning org can publish/unpublish. No other PUT change.)

- [ ] **Step 9: Make the community "Publish" dialog set `visibility: 'global'`**

In `src/app/templates/page.tsx`, the create/edit dialog is the explicit "Publish to the community library" action, so it must publish globally. In `saveAsset` (near line 168), change the template payload to include `visibility: 'global'`:

```ts
        ? { name: dialog.name, category: dialog.category, description: dialog.description, instructions: dialog.instructions, tags: csv(dialog.tags), integrations: csv(dialog.integrations), exampleOutput: dialog.exampleOutput || undefined, visibility: 'global' }
```

- [ ] **Step 10: Run the pure test + typecheck**

Run: `npx tsx --test src/lib/templates/__tests__/serialize.test.ts && npm run typecheck`
Expected: serialize tests PASS (2); typecheck clean (route imports resolve, `visibility` on the schema/PUT compiles).

- [ ] **Step 11: Commit**

```bash
git add src/lib/templates/create-template.ts src/lib/templates/catalogue.ts src/lib/templates/__tests__/serialize.test.ts src/lib/templates/__tests__/create-template.test.ts src/app/api/agent-templates/route.ts src/app/templates/page.tsx
git commit -m "feat(templates): createTemplate writer + org-default POST + publish-to-global PUT; move serializer to lib"
```

---

### Task 3: Read path — org-scoped, prioritized catalogue

**Files:**
- Modify: `src/lib/templates/catalogue.ts` (add `sortStoredTemplates` + `fetchCatalogueRows` + `listStoredCatalogue`)
- Modify: `src/app/api/agent-templates/route.ts` (rewrite GET to use the lib)
- Create: `src/lib/templates/__tests__/ranking.test.ts`
- Create: `src/app/api/agent-templates/__tests__/scoping.test.ts`

**Interfaces:**
- Consumes: `serializeTemplate` (Task 2), the `source`/`visibility` columns (Task 1).
- Produces:
  - `sortStoredTemplates<T extends StoredTemplateRow>(rows: T[], viewerOrgId: string): T[]` — pure comparator; own `ai_generated` → own `user`/other → other-orgs' rows, newest-first within a group.
  - `fetchCatalogueRows(organizationId: string): Promise<{ own: AgentTemplate[]; global: AgentTemplate[] }>` — own rows (any visibility) via tenant-guarded `prisma`; other-orgs' `visibility='global'` rows via `systemPrisma`.
  - `listStoredCatalogue(organizationId: string): Promise<SerializedTemplate[]>` — own+global, ranked own-first, serialized. The GET route appends built-ins after this.

- [ ] **Step 1: Write the failing ranking test (pure, no DB)**

Create `src/lib/templates/__tests__/ranking.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortStoredTemplates } from '../catalogue'

const d = (iso: string) => new Date(iso)

test('sortStoredTemplates ranks own ai_generated, then own user, then other-org global; newest-first within a group', () => {
  const rows = [
    { id: 'other-new', organizationId: 'orgB', source: 'user', visibility: 'global', updatedAt: d('2026-07-10') },
    { id: 'own-user-old', organizationId: 'orgA', source: 'user', visibility: 'org', updatedAt: d('2026-01-01') },
    { id: 'own-ai', organizationId: 'orgA', source: 'ai_generated', visibility: 'org', updatedAt: d('2026-02-01') },
    { id: 'own-user-new', organizationId: 'orgA', source: 'user', visibility: 'global', updatedAt: d('2026-07-01') },
    { id: 'other-old', organizationId: 'orgB', source: 'user', visibility: 'global', updatedAt: d('2026-01-01') },
  ]
  const sorted = sortStoredTemplates(rows, 'orgA').map((r) => r.id)
  assert.deepEqual(sorted, ['own-ai', 'own-user-new', 'own-user-old', 'other-new', 'other-old'])
})

test('sortStoredTemplates defaults missing source to user (own non-ai ranks in the user group)', () => {
  const rows = [
    { id: 'own-nosrc', organizationId: 'orgA', visibility: 'org', updatedAt: d('2026-03-01') },
    { id: 'own-ai', organizationId: 'orgA', source: 'ai_generated', visibility: 'org', updatedAt: d('2026-01-01') },
  ]
  assert.deepEqual(sortStoredTemplates(rows, 'orgA').map((r) => r.id), ['own-ai', 'own-nosrc'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/templates/__tests__/ranking.test.ts`
Expected: FAIL — `sortStoredTemplates` is not exported from `../catalogue`.

- [ ] **Step 3: Add the ranking comparator + catalogue fetch to the lib**

Append to `src/lib/templates/catalogue.ts` (add the `prisma`/`systemPrisma` + `AgentTemplate` imports at the top of the file alongside the existing `import type { AgentTemplate } from '@prisma/client'`):

```ts
import { prisma, systemPrisma } from '@/lib/prisma'
```

Then append these exports:

```ts
export type StoredTemplateRow = { organizationId: string; source?: string | null; visibility?: string | null; updatedAt: Date }

/**
 * Rank stored templates for a viewer: the org's own templates first
 * (ai_generated above user-authored), then other orgs' global community
 * templates. Newest-first within each group. Pure — no DB.
 */
export function sortStoredTemplates<T extends StoredTemplateRow>(rows: T[], viewerOrgId: string): T[] {
  const groupOf = (row: T): number => {
    const own = row.organizationId === viewerOrgId
    if (own && (row.source ?? 'user') === 'ai_generated') return 0
    if (own) return 1
    return 2 // other orgs' global community templates
  }
  return [...rows].sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    if (ga !== gb) return ga - gb
    return b.updatedAt.getTime() - a.updatedAt.getTime()
  })
}

/**
 * The catalogue rows for a viewer: their own templates (any visibility) via the
 * tenant-guarded client, plus OTHER orgs' global community templates. The only
 * cross-org read is the global slice.
 */
export async function fetchCatalogueRows(organizationId: string): Promise<{ own: AgentTemplate[]; global: AgentTemplate[] }> {
  const own = await prisma.agentTemplate.findMany({ where: { organizationId, isActive: true } })
  // systemPrisma: cross-org read of the PUBLIC community slice only — global
  // templates from OTHER orgs. Own rows come from the tenant-guarded query above.
  const globalRows = await systemPrisma.agentTemplate.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return { own, global: globalRows }
}

/** Own + global community templates, ranked own-first, serialized. */
export async function listStoredCatalogue(organizationId: string): Promise<SerializedTemplate[]> {
  const { own, global } = await fetchCatalogueRows(organizationId)
  return sortStoredTemplates([...own, ...global], organizationId).map((row) => serializeTemplate(row, organizationId))
}
```

- [ ] **Step 4: Run the ranking test to verify it passes**

Run: `npx tsx --test src/lib/templates/__tests__/ranking.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Rewrite the GET route to use the lib**

In `src/app/api/agent-templates/route.ts`, add `listStoredCatalogue` to the catalogue import:

```ts
import { serializeTemplate, listStoredCatalogue } from '@/lib/templates/catalogue'
```

Replace the GET handler (currently lines 736–751) with:

```ts
export const GET = withAuthenticatedApi(async (request, auth) => {
  // Org's own templates (any visibility) + other orgs' global community
  // templates, ranked own-first; built-ins last. Scoping/prioritization lives
  // in listStoredCatalogue (src/lib/templates/catalogue.ts).
  const stored = await listStoredCatalogue(auth.organizationId)
  const templates = [
    ...stored,
    ...builtInTemplates.map((t) => ({ ...t, custom: false, mine: false })),
  ]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})
```

- [ ] **Step 6: Write the failing scoping test (DB-gated)**

Create `src/app/api/agent-templates/__tests__/scoping.test.ts`:

```ts
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
```

- [ ] **Step 7: Run the scoping test (skips locally) + the pure test + typecheck**

Run: `npx tsx --test src/app/api/agent-templates/__tests__/scoping.test.ts src/lib/templates/__tests__/ranking.test.ts && npm run typecheck`
Expected: the scoping file runs 0 tests locally (no `TEST_DATABASE_URL`) — note it; ranking tests PASS; typecheck clean. (The scoping test runs green in CI where `TEST_DATABASE_URL` is set.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/templates/catalogue.ts src/app/api/agent-templates/route.ts src/lib/templates/__tests__/ranking.test.ts src/app/api/agent-templates/__tests__/scoping.test.ts
git commit -m "feat(templates): org-scoped, org-prioritized catalogue read (own + global community, built-ins last)"
```

---

## Self-Review

**1. Spec coverage** (against sub-project A of the umbrella spec):
- Migration adding `source`/`visibility` + backfill existing → `global` + `@@index([organizationId, visibility])`: Task 1. ✅
- Single `createTemplate()` writer setting source/visibility/org/user, callable by C: Task 2 (with the `source:'ai_generated'` path tested). ✅
- GET scoping: own (any visibility) ∪ other-orgs' `global`, ordered own-first (`ai_generated` above `user`) then global then built-ins, `systemPrisma` only for the global slice with a justification comment: Task 3. ✅
- POST defaults `visibility:'org'` + publish-to-global (PUT flip): Task 2. ✅
- Tests — route scoping (own+global, not other-orgs' org rows; own-first), createTemplate field-setting, serializer: Tasks 2–3. The migration backfill has no fresh-DB unit test (documented in Task 1 Step 5 — it's a no-op on an empty DB); it's verified by inspection and exercised implicitly by the seeded scoping test. ✅

**2. Placeholder scan:** No TBD/TODO. The migration timestamp is a concrete instruction (`20260711120000_…`, later than the latest existing migration). DB-gated tests explicitly document the local-skip behavior rather than pretending to run. Every code step shows complete code. ✅

**3. Type consistency:** `createTemplate` params (`category`→`type`, `source`, `visibility`) match the `CreateTemplateParams` interface and the POST call site. `serializeTemplate(row, viewerOrgId)` signature is identical where defined (Task 2) and consumed (Task 3 GET + POST/PUT returns). `sortStoredTemplates`/`fetchCatalogueRows`/`listStoredCatalogue` names match between the lib (Task 3 Step 3) and the GET route (Task 3 Step 5). `StoredTemplateRow`/`AgentTemplateRow`/`SerializedTemplate` types are defined once in `catalogue.ts` and reused. ✅

**Cross-task note for the executor:** Task 2 and Task 3 both edit `src/lib/templates/catalogue.ts` and `src/app/api/agent-templates/route.ts` — run them in order (2 before 3); Task 3 appends to the file Task 2 created and rewrites the GET the earlier task left intact.
