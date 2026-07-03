import 'dotenv/config'
import Fastify from 'fastify'
import { Worker } from 'bullmq'
import { executeAgentJob } from '@/features/agents/execute-agent'
import { getRedisConnection, QUEUE_NAMES, workerConfig } from '@/lib/queue/config'
import { deadLetterFromJob } from '@/lib/queue/dead-letter'
import { registerAgentSchedules } from '@/lib/workers/agent-schedule-registrar'

class WorkerRuntime {
  private server = Fastify({ logger: true })
  private scheduleTimer?: NodeJS.Timeout
  private workers = [
    new Worker(QUEUE_NAMES.AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
    new Worker(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
  ]

  constructor() {
    this.server.get('/health', async () => ({
      status: 'healthy',
      workers: ['agent-execution', 'scheduled-agent-execution'],
      uptime: process.uptime(),
    }))
    // Failed jobs (single attempt — no side-effect replay) are dead-lettered.
    const queues = [QUEUE_NAMES.AGENT_EXECUTION, QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION]
    this.workers.forEach((worker, index) => worker.on('failed', deadLetterFromJob(queues[index])))
    this.setupShutdown()
  }

  private setupShutdown() {
    const shutdown = async () => {
      if (this.scheduleTimer) clearInterval(this.scheduleTimer)
      await this.server.close()
      await Promise.all(this.workers.map((worker) => worker.close()))
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  async start(port = 3002) {
    await registerAgentSchedules()
    this.scheduleTimer = setInterval(() => {
      registerAgentSchedules().catch((error) => this.server.log.error(error, 'Schedule reconciliation failed'))
    }, 60_000)
    await this.server.listen({ port, host: '0.0.0.0' })
  }
}

if (require.main === module) {
  new WorkerRuntime().start(Number(process.env.WORKER_PORT) || 3002).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

export { WorkerRuntime }
