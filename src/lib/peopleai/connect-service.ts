/**
 * People.ai connect flow — service layer under /api/peopleai/connect and
 * /api/peopleai/callback. Thin routes handle the HTTP/cookie mechanics; this
 * module owns state, token exchange, identity extraction, persistence, and
 * the org=team binding.
 */

import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { encryptSecret } from '@/lib/crypto/secrets'
import { revalidateEntitlement } from '@/lib/entitlement'
import {
  buildAuthorizeUrl,
  discoverMetadata,
  exchangeCode,
  generatePkce,
  type PeopleAiOAuthConfig,
  type TokenSet,
} from './oauth'

/** Short-lived HttpOnly cookie carrying state + PKCE verifier across the redirect. */
export const OAUTH_COOKIE = 'pai_oauth'

export interface ConnectStart {
  authorizeUrl: string
  /** Serialize into a short-lived HttpOnly cookie; verified on callback. */
  statePayload: { state: string; verifier: string; returnTo: string }
}

export async function startConnect(
  config: PeopleAiOAuthConfig,
  returnTo: string,
): Promise<ConnectStart> {
  const { verifier, challenge } = generatePkce()
  const state = crypto.randomBytes(24).toString('base64url')
  const metadata = await discoverMetadata(config)
  const authorizeUrl = buildAuthorizeUrl(config, {
    authorizationEndpoint: metadata.authorizationEndpoint,
    state,
    codeChallenge: challenge,
  })
  return { authorizeUrl, statePayload: { state, verifier, returnTo } }
}

// ── Identity extraction ─────────────────────────────────────────────────────

export interface PeopleAiIdentity {
  teamId: string | null
  membershipId: string | null
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  // mcp_* tokens are documented as JWTs; tolerate an mcp_ prefix before the
  // JWT body and any non-JWT shape (return null rather than throw).
  const candidate = token.startsWith('mcp_') ? token.slice(4) : token
  const parts = candidate.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

/**
 * Extract team/membership identity from the token exchange response: explicit
 * response fields first, then JWT claims. SEAM: if People.ai's real token
 * shape differs, adjust the key lists here — callers only see the two ids.
 */
export function extractIdentity(tokens: TokenSet): PeopleAiIdentity {
  const raw = tokens.raw
  const claims = decodeJwtClaims(tokens.accessToken)
  const teamId =
    firstString(raw, ['team_id', 'org_id', 'organization_id']) ??
    firstString(claims, ['team_id', 'org_id', 'organization_id'])
  const membershipId =
    firstString(raw, ['membership_id', 'user_id']) ??
    firstString(claims, ['membership_id', 'user_id', 'sub'])
  return { teamId, membershipId }
}

// ── Callback completion ─────────────────────────────────────────────────────

export class TeamMismatchError extends Error {
  constructor() {
    super('This workspace is already linked to a different People.ai team.')
    this.name = 'TeamMismatchError'
  }
}

export interface CompleteConnectInput {
  userId: string
  organizationId: string
  code: string
  verifier: string
  config: PeopleAiOAuthConfig
  /** Injectable for tests; defaults to the real token exchange. */
  exchanger?: (config: PeopleAiOAuthConfig, params: { tokenEndpoint: string; code: string; codeVerifier: string }) => Promise<TokenSet>
}

export async function completeConnect(input: CompleteConnectInput): Promise<PeopleAiIdentity> {
  const exchanger = input.exchanger ?? exchangeCode
  const metadata = await discoverMetadata(input.config)
  const tokens = await exchanger(input.config, {
    tokenEndpoint: metadata.tokenEndpoint,
    code: input.code,
    codeVerifier: input.verifier,
  })

  const identity = extractIdentity(tokens)

  // Bind the workspace to the People.ai team on first connect; refuse to mix
  // teams inside one workspace (tenant isolation).
  if (identity.teamId) {
    const org = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { peopleAiTeamId: true },
    })
    if (org?.peopleAiTeamId && org.peopleAiTeamId !== identity.teamId) {
      throw new TeamMismatchError()
    }
    if (!org?.peopleAiTeamId) {
      await prisma.organization.update({
        where: { id: input.organizationId },
        data: { peopleAiTeamId: identity.teamId },
      })
    }
  }

  await prisma.peopleAiConnection.upsert({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
    create: {
      organizationId: input.organizationId,
      userId: input.userId,
      teamId: identity.teamId,
      membershipId: identity.membershipId,
      scope: input.config.scope ?? null,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
    update: {
      teamId: identity.teamId,
      membershipId: identity.membershipId,
      scope: input.config.scope ?? null,
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
  })

  if (identity.membershipId) {
    await prisma.user.update({
      where: { id: input.userId },
      data: { peopleAiMembershipId: identity.membershipId },
    })
  }

  await revalidateEntitlement(input.organizationId)
  return identity
}

export async function disconnect(userId: string, organizationId: string): Promise<void> {
  await prisma.peopleAiConnection.deleteMany({ where: { organizationId, userId } })
  await revalidateEntitlement(organizationId)
}
