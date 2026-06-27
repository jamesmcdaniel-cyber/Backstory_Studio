/**
 * /api/cron/dispatch — Vercel Cron handler
 *
 * Fires every 15 minutes (see vercel.json). For each active agentTask whose
 * schedule is due, creates an agentExecution row and runs it inline.
 *
 * Auth: CRON_SECRET env var MUST be set. Requests must carry:
 *   Authorization: Bearer <CRON_SECRET>
 * (Vercel sets this header automatically when the secret is configured in the
 * project settings alongside the cron entry.)
 *
 * If CRON_SECRET is not set the handler fails closed with 401, unless the
 * request comes from Vercel's internal cron infrastructure (x-vercel-cron
 * header). In production, always set CRON_SECRET.
 */

import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { composeInstructions } from '@/lib/skills/compose'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { isDue, type AgentSchedule } from '@/lib/scheduling/due'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const MAX_AGENTS_PER_TICK = 25

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET

  if (!secret) {
    // Fail closed unless Vercel's internal cron header is present
    const isVercelCron = request.headers.get('x-vercel-cron') === '1'
    if (isVercelCron) {
      // Allow only if in a non-production environment (dev/preview)
      // In production, CRON_SECRET must always be set.
      return process.env.NODE_ENV !== 'production'
    }
    return false
  }

  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!provided) return false

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Load all active agents (capped at 200 to avoid huge fetches)
    const agents = await prisma.agentTask.findMany({
      where: { status: 'ACTIVE' },
      take: 200,
    })

    const now = new Date()

    // Filter to agents whose schedule is currently due
    const dueAgents = agents
      .filter((agent) => {
        const schedule = agent.schedule as unknown as AgentSchedule | null
        if (!schedule || typeof schedule !== 'object') return false
        return isDue(schedule, agent.lastExecutedAt, now)
      })
      .slice(0, MAX_AGENTS_PER_TICK)

    const dueCount = dueAgents.length
    const ranIds: string[] = []

    for (const agent of dueAgents) {
      const metadata =
        agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
          ? (agent.metadata as Record<string, unknown>)
          : {}

      // Find the first active user in the org
      const user = await prisma.user.findFirst({
        where: { organizationId: agent.organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
      })

      if (!user) {
        apiLogger.error('cron/dispatch: no active user found, skipping agent', {
          agentId: agent.id,
          organizationId: agent.organizationId,
        })
        continue
      }

      const skillIds: string[] = Array.isArray(metadata.skills)
        ? (metadata.skills as string[])
        : []
      const input = composeInstructions(agent.objective, skillIds)

      // Create the execution row in pending state
      const execution = await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'pending',
          input: { prompt: input },
          trigger: { type: 'schedule' },
          metadata: { title: (metadata.title as string) || agent.description },
          userId: user.id,
          organizationId: agent.organizationId,
        },
      })

      try {
        await runAgentExecution({
          executionId: execution.id,
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: user.id,
          input,
        })
        ranIds.push(agent.id)
      } catch (error) {
        apiLogger.error('cron/dispatch: agent execution failed', {
          agentId: agent.id,
          executionId: execution.id,
          error: error instanceof Error ? error.message : String(error),
        })
        await prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            completedAt: new Date(),
          },
        })
      }

      // Update the agent's lastExecutedAt and increment executionCount
      await prisma.agentTask.update({
        where: { id: agent.id },
        data: {
          lastExecutedAt: new Date(),
          executionCount: { increment: 1 },
        },
      })
    }

    return Response.json({ success: true, due: dueCount, ran: ranIds })
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
