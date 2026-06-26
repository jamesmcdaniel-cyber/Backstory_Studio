import IORedis from 'ioredis'
import { Queue, type QueueOptions, type WorkerOptions } from 'bullmq'

export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
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
  lockDuration: 120_000,
} satisfies Partial<WorkerOptions>

export function createQueue(name: string, overrides: Partial<QueueOptions> = {}) {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
    ...overrides,
  })
}
