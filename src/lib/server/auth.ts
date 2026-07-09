import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { resolveEntitlement } from '@/lib/entitlement'
import { backstoryGateEnabled, backstoryMcpReady, ensureBackstoryConnection } from '@/lib/mcp/backstory-connection'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string = 'AUTH_ERROR',
  ) {
    super(message)
    this.name = 'AuthContextError'
  }
}

/**
 * The entitlement gate is enforced in production (Backstory Studio is
 * exclusively for People.ai Sales AI customers). In development it defaults
 * off so a fresh clone works; force with ENTITLEMENT_GATE=on|off.
 */
export function entitlementGateEnabled(): boolean {
  const flag = process.env.ENTITLEMENT_GATE
  if (flag === 'on') return true
  if (flag === 'off') return false
  return process.env.NODE_ENV === 'production'
}

/** Throws 403 ENTITLEMENT_REQUIRED when the org has no active Sales AI entitlement. */
export async function assertEntitled(organizationId: string): Promise<void> {
  const entitlement = await resolveEntitlement(organizationId)
  if (!entitlement.entitled) {
    throw new AuthContextError(
      'An active Backstory Sales AI connection is required.',
      403,
      'ENTITLEMENT_REQUIRED',
    )
  }
}

export async function requireAuthContext(options?: { skipBackstoryGate?: boolean }): Promise<AuthContext> {
  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  if (entitlementGateEnabled()) {
    await assertEntitled(auth.organizationId)
  }

  // Native Backstory MCP: seed the per-user connection row (idempotent, never
  // throws), then hard-gate the platform until the user has authorized it.
  await ensureBackstoryConnection(auth.organizationId, auth.dbUser.id)
  if (!options?.skipBackstoryGate && backstoryGateEnabled()) {
    const ready = await backstoryMcpReady(auth.organizationId, auth.dbUser.id)
    if (!ready) {
      throw new AuthContextError(
        'Connect your Backstory MCP account to continue.',
        403,
        'BACKSTORY_MCP_REQUIRED',
      )
    }
  }

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
  }
}
