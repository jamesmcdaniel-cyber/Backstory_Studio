/**
 * /api/cron/retention — daily pruning of unbounded-growth tables.
 *
 * Deletes agent executions and signals older than RETENTION_DAYS (default 90).
 * Deleting an execution cascades its workflow steps/events/messages. Audit
 * events are intentionally NOT pruned (append-only for compliance). Capped per
 * run so a backlog is worked down over successive days rather than in one huge
 * transaction.
 *
 * Auth (fail closed): requires Authorization: Bearer <CRON_SECRET>.
 */

import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const CAP = 5000

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  const days = Number(process.env.RETENTION_DAYS) || 90
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  try {
    const staleExecutions = await prisma.agentExecution.findMany({
      where: { startedAt: { lt: cutoff } }, select: { id: true }, take: CAP,
    })
    const executionsDeleted = staleExecutions.length
      ? (await prisma.agentExecution.deleteMany({ where: { id: { in: staleExecutions.map((e) => e.id) } } })).count
      : 0

    const staleSignals = await prisma.signal.findMany({
      where: { receivedAt: { lt: cutoff } }, select: { id: true }, take: CAP,
    })
    const signalsDeleted = staleSignals.length
      ? (await prisma.signal.deleteMany({ where: { id: { in: staleSignals.map((s) => s.id) } } })).count
      : 0

    apiLogger.info('cron/retention complete', { days, executionsDeleted, signalsDeleted })
    return Response.json({ success: true, days, executionsDeleted, signalsDeleted })
  } catch (error) {
    apiLogger.error('cron/retention failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
