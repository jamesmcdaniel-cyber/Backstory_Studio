/**
 * Per-organization People.ai webhook signing secrets.
 *
 * The receiver verifies each delivery's HMAC against the TARGET org's own
 * secret, so possessing one org's secret cannot authenticate a payload that
 * names another org's team_id. Secrets are stored encrypted (reversible —
 * HMAC verification needs the plaintext), minted when the org's
 * peopleAiTeamId is first bound, and rotatable by an org admin.
 */

import { randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

export function mintWebhookSecret(): string {
  return `pai_whsec_${randomBytes(32).toString('base64url')}`
}

/** Mint and persist a secret if the org has none; return the plaintext either way. */
export async function ensureOrgWebhookSecret(organizationId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  if (org?.peopleAiWebhookSecret) return decryptSecret(org.peopleAiWebhookSecret)
  const secret = mintWebhookSecret()
  // Guarded write: only fill an empty slot, so a concurrent mint cannot
  // overwrite a secret another request just stored (last-write-wins here
  // would invalidate a secret already handed to People.ai).
  const claimed = await prisma.organization.updateMany({
    where: { id: organizationId, peopleAiWebhookSecret: null },
    data: { peopleAiWebhookSecret: encryptSecret(secret) },
  })
  if (claimed.count === 1) return secret
  const winner = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  if (!winner?.peopleAiWebhookSecret) throw new Error('Failed to persist webhook secret')
  return decryptSecret(winner.peopleAiWebhookSecret)
}

/** The org's plaintext signing secret, or null if none minted yet. */
export async function orgWebhookSecret(organizationId: string): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { peopleAiWebhookSecret: true },
  })
  return org?.peopleAiWebhookSecret ? decryptSecret(org.peopleAiWebhookSecret) : null
}

/** Rotate: overwrite unconditionally, return the new plaintext. */
export async function rotateOrgWebhookSecret(organizationId: string): Promise<string> {
  const secret = mintWebhookSecret()
  await prisma.organization.update({
    where: { id: organizationId },
    data: { peopleAiWebhookSecret: encryptSecret(secret) },
  })
  return secret
}
