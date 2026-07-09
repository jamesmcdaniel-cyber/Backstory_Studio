import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/** The natively-included Backstory MCP server every user connects to. */
export const BACKSTORY_MCP_DEFAULT_URL = 'https://mcp.backstory.ai/mcp'
export const BACKSTORY_PROVIDER = 'backstory'

export function backstoryServerUrl(): string {
  return process.env.BACKSTORY_MCP_URL?.trim() || BACKSTORY_MCP_DEFAULT_URL
}

/**
 * The Backstory MCP gate is enforced in production; in development it
 * defaults off so a fresh clone works. Force with BACKSTORY_MCP_GATE=on|off.
 */
export function backstoryGateEnabled(): boolean {
  const flag = process.env.BACKSTORY_MCP_GATE
  if (flag === 'on') return true
  if (flag === 'off') return false
  return process.env.NODE_ENV === 'production'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Pure gate decision over the user's Backstory connection row. */
export function evaluateBackstoryReady(row: { isActive: boolean; authConfig: unknown } | null): boolean {
  if (!row || !row.isActive) return false
  const config = row.authConfig
  if (!isRecord(config)) return false
  return config.flow === 'authcode' && typeof config.accessToken === 'string' && config.accessToken.length > 0
}

const READY_TTL_MS = 60_000
export function readyCacheFresh(cachedAt: number, now: number = Date.now()): boolean {
  return now - cachedAt < READY_TTL_MS
}

const readyCache = new Map<string, { ready: boolean; cachedAt: number }>()
const seededMemo = new Set<string>()
const cacheKey = (organizationId: string, userId: string) => `${organizationId}:${userId}`

export function bustBackstoryReadyCache(organizationId: string, userId: string): void {
  readyCache.delete(cacheKey(organizationId, userId))
}

/**
 * Idempotently seed the per-user Backstory MCP row (inactive until OAuth
 * completes). Never throws — sign-in must not be blocked by the seeder.
 */
export async function ensureBackstoryConnection(organizationId: string, userId: string): Promise<void> {
  const key = cacheKey(organizationId, userId)
  if (seededMemo.has(key)) return
  try {
    await prisma.mcpConnection.upsert({
      where: {
        organizationId_userId_provider: {
          organizationId,
          userId,
          provider: BACKSTORY_PROVIDER,
        },
      },
      update: {},
      create: {
        organizationId,
        userId,
        provider: BACKSTORY_PROVIDER,
        name: 'Backstory MCP',
        description: 'Native Backstory tools',
        serverUrl: backstoryServerUrl(),
        authType: 'oauth2',
        authConfig: {},
        isActive: false,
      },
    })
    seededMemo.add(key)
  } catch (error) {
    apiLogger.warn('Backstory MCP seeding failed; will retry next request', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Cached (60s) gate check: does this user have an authorized Backstory row? */
export async function backstoryMcpReady(organizationId: string, userId: string): Promise<boolean> {
  const key = cacheKey(organizationId, userId)
  const cached = readyCache.get(key)
  if (cached && readyCacheFresh(cached.cachedAt)) return cached.ready
  const row = await prisma.mcpConnection.findFirst({
    where: { organizationId, userId, provider: BACKSTORY_PROVIDER },
    select: { isActive: true, authConfig: true },
  })
  const ready = evaluateBackstoryReady(row)
  readyCache.set(key, { ready, cachedAt: Date.now() })
  return ready
}
