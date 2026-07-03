import IORedis from 'ioredis'
import { Queue, type QueueOptions, type WorkerOptions } from 'bullmq'

export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
  // Poison jobs land here after their single attempt fails, so a failed run is
  // durably inspectable (and re-runnable by an operator) instead of vanishing.
  // We do NOT auto-retry: agent runs have external side effects.
  DEAD_LETTER: 'agent-dead-letter',
} as const

const buildPhase = process.env.NEXT_PHASE === 'phase-production-build'
export const workersEnabled = process.env.BULLMQ_DISABLE !== 'true' && !buildPhase

let connection: IORedis | null = null

export function getRedisConnection() {
  if (!workersEnabled) throw new Error('BullMQ is disabled')
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for the worker runtime')
  connection ??= new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  })
  return connection
}

export const workerConfig = {
  concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY) || 3,
  // Agent runs are long (multi-turn) and have external side effects (emails,
  // Slack posts). Hold the lock long enough that a live run isn't declared
  // stalled, and never re-run a stalled job — a half-finished run must not be
  // replayed from the top. runAgentExecution is also idempotent per execution.
  lockDuration: 300_000,
  maxStalledCount: 0,
} satisfies Partial<WorkerOptions>

export function createQueue(name: string, overrides: Partial<QueueOptions> = {}) {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // No automatic retries: a retry replays the whole tool loop and re-fires
      // side effects. Failures surface in the UI where a user can re-run.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
    ...overrides,
  })
}
