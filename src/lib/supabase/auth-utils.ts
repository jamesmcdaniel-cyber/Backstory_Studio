import type { User } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { supabaseId, isActive: true },
    include: { organization: true },
  })
}

// Per-instance cache of the supabaseId → app user (+org) lookup. This query
// runs on EVERY authenticated API request via requireAuthContext; the row
// changes rarely (role/org edits), so a short TTL removes a DB round-trip from
// the hot path on warm instances while bounding staleness to one minute.
type DbUserRow = Awaited<ReturnType<typeof findDbUser>>
const DB_USER_TTL_MS = 60_000
const dbUserCache = new Map<string, { row: NonNullable<DbUserRow>; ts: number }>()

async function findDbUserCached(supabaseId: string): Promise<DbUserRow> {
  const hit = dbUserCache.get(supabaseId)
  if (hit && Date.now() - hit.ts < DB_USER_TTL_MS) return hit.row
  const row = await findDbUser(supabaseId)
  if (row) dbUserCache.set(supabaseId, { row, ts: Date.now() })
  else dbUserCache.delete(supabaseId)
  return row
}

// Self-healing bootstrap: the handle_new_user Postgres trigger is optional
// infra that may never be installed, so provision the app user + organization
// on first authenticated request when they don't exist yet.
async function provisionUser(user: User) {
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  const emailPrefix = (user.email || 'user').split('@')[0]
  const metaString = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const orgName = metaString('organization_name') || metaString('full_name') || emailPrefix
  const name = metaString('full_name') || emailPrefix

  try {
    return await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: orgName, slug: `org-${user.id}` },
      })
      return tx.user.create({
        data: {
          supabaseId: user.id,
          email: user.email ?? null,
          name,
          role: 'ADMIN',
          organizationId: organization.id,
        },
        include: { organization: true },
      })
    })
  } catch {
    // Lost a race (unique supabaseId/slug) or the trigger created it
    // concurrently — re-read whatever now exists.
    return findDbUser(user.id)
  }
}

export async function getAuthWithUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (error || !user) return null

  const dbUser = (await findDbUserCached(user.id)) ?? (await provisionUser(user))

  return {
    user,
    userId: user.id,
    dbUser,
    organizationId: dbUser?.organizationId ?? null,
  }
}

export async function requireAuth() {
  const auth = await getAuthWithUser()
  return auth?.dbUser ? auth : null
}
