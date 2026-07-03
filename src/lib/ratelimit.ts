/**
 * Shared rate limiter.
 *
 * Sliding-window counter, keyed by caller-chosen strings (e.g. `signals:<ip>`,
 * `trigger:<agentId>`). In-memory by default — correct per serverless instance
 * and per worker process, which is sufficient to blunt abuse on public
 * endpoints. When REDIS_URL is set (worker/queue deployments), a Redis-backed
 * window makes the limit global across processes.
 */

import { Redis } from 'ioredis'

export interface RateLimitOptions {
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  retryAfterMs?: number
}

export interface RateLimiter {
  check(key: string, options: RateLimitOptions): Promise<RateLimitResult>
}

interface CreateOptions {
  now?: () => number
  redisUrl?: string
}

export function createRateLimiter(create: CreateOptions = {}): RateLimiter {
  const now = create.now ?? Date.now
  const redisUrl = create.redisUrl ?? process.env.REDIS_URL

  if (redisUrl && !create.now) {
    return createRedisLimiter(redisUrl)
  }
  return createMemoryLimiter(now)
}

function createMemoryLimiter(now: () => number): RateLimiter {
  const hits = new Map<string, number[]>()

  return {
    async check(key, { limit, windowMs }) {
      const cutoff = now() - windowMs
      const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff)

      if (timestamps.length >= limit) {
        hits.set(key, timestamps)
        const oldest = timestamps[0]
        return { ok: false, retryAfterMs: Math.max(1, oldest + windowMs - now()) }
      }

      timestamps.push(now())
      hits.set(key, timestamps)

      // Opportunistic cleanup so long-lived processes don't accumulate keys.
      if (hits.size > 10_000) {
        for (const [candidate, stamps] of hits) {
          if (stamps.every((t) => t <= cutoff)) hits.delete(candidate)
        }
      }

      return { ok: true }
    },
  }
}

function createRedisLimiter(redisUrl: string): RateLimiter {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true })

  return {
    async check(key, { limit, windowMs }) {
      try {
        const redisKey = `ratelimit:${key}`
        const count = await redis.incr(redisKey)
        if (count === 1) await redis.pexpire(redisKey, windowMs)
        if (count > limit) {
          const ttl = await redis.pttl(redisKey)
          return { ok: false, retryAfterMs: Math.max(1, ttl) }
        }
        return { ok: true }
      } catch {
        // Redis being down must not take the endpoint down with it.
        return { ok: true }
      }
    },
  }
}

/** Process-wide default limiter for route handlers. */
let defaultLimiter: RateLimiter | null = null

export function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  defaultLimiter ??= createRateLimiter()
  return defaultLimiter.check(key, options)
}
