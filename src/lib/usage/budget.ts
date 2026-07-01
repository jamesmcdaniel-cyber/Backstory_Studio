import { prisma } from '@/lib/prisma'

/**
 * Month-to-date token budget for an organization. Enforced at the start of every
 * agent run so a runaway agent (or an expired trial) can't burn unbounded spend.
 *
 * The ceiling is set via AGENT_MONTHLY_TOKEN_LIMIT (total input+output tokens per
 * UTC calendar month). Unset or 0 means unlimited — enforcement is opt-in.
 */
export async function checkMonthlyTokenBudget(
  organizationId: string,
): Promise<{ over: boolean; used: number; limit: number }> {
  const limit = Number(process.env.AGENT_MONTHLY_TOKEN_LIMIT) || 0
  if (limit <= 0) return { over: false, used: 0, limit: 0 }

  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const aggregate = await prisma.agentExecution.aggregate({
    where: { organizationId, startedAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  })
  const used = (aggregate._sum.inputTokens || 0) + (aggregate._sum.outputTokens || 0)

  return { over: used >= limit, used, limit }
}
