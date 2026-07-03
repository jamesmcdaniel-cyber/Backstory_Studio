/**
 * One-time (re-runnable) graph-RAG backfill for an organization.
 *
 * Indexing normally fills forward from new signals/runs/agent-saves. Backfill
 * seeds the graph from what already exists:
 *   1. Sales AI book — top_records → account + opportunity nodes, enriched with
 *      get_account_status / get_opportunity_status (the org's real book of
 *      business, the highest-value seed).
 *   2. Agents, executions, and signals already in the database.
 *
 * Idempotent (stable node ids upsert in place) and gated on ragEnabled(). Safe
 * to run repeatedly; bounded by caps so a huge org can't run unbounded.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getPeopleAiServiceClient } from '@/lib/peopleai/client'
import { enrichAccount, enrichOpportunity, extractMcpText } from '@/lib/peopleai/salesai-facts'
import { commitGraph, indexAgent, indexExecution, indexSignal, nodeIds, type PendingNode } from './indexer'
import { ragEnabled } from './get-store'
import type { GraphEdge } from './store'

export interface BackfillResult {
  accounts: number
  opportunities: number
  agents: number
  executions: number
  signals: number
  skipped?: string
}

const CAPS = { accounts: 50, oppsPerAccount: 20, agents: 200, executions: 300, signals: 500 }

interface TopAccount {
  peopleai_account_id?: number
  name?: string
  domain?: string
  opportunities?: Array<{
    peopleai_opportunity_id?: number
    opportunity_name?: string
    amount?: number
    close_date?: string
    engagement_level?: number
    type?: string
    owner?: { name?: string }
  }>
}

/** Pull the org's Sales AI book (accounts + opportunities) and index it, enriched. */
async function indexSalesAiBook(organizationId: string): Promise<{ accounts: number; opportunities: number }> {
  const client = getPeopleAiServiceClient()
  if (!client) return { accounts: 0, opportunities: 0 }

  let records: TopAccount[] = []
  try {
    const result = await client.callTool('top_records', {})
    records = JSON.parse(extractMcpText(result)) as TopAccount[]
  } catch (error) {
    apiLogger.warn('backfill.top_records failed', { error: error instanceof Error ? error.message : String(error) })
    return { accounts: 0, opportunities: 0 }
  }
  if (!Array.isArray(records)) return { accounts: 0, opportunities: 0 }

  const nodes: PendingNode[] = []
  const edges: GraphEdge[] = []
  let accounts = 0
  let opportunities = 0

  for (const account of records.slice(0, CAPS.accounts)) {
    const acctId = account.peopleai_account_id
    if (acctId == null) continue
    const acctKey = String(acctId)
    const facts = await enrichAccount(client, acctId).catch(() => null)
    nodes.push({
      id: nodeIds.account(acctKey),
      type: 'account',
      text: facts?.text
        ? `Account: ${account.name ?? acctKey} (${account.domain ?? ''}). Sales AI status: ${facts.text}`
        : `Account: ${account.name ?? acctKey} (${account.domain ?? ''})`,
      props: { peopleaiAccountId: acctId, name: account.name, domain: account.domain },
    })
    accounts++

    for (const opp of (account.opportunities ?? []).slice(0, CAPS.oppsPerAccount)) {
      const oppId = opp.peopleai_opportunity_id
      if (oppId == null) continue
      const oppKey = String(oppId)
      const oppFacts = await enrichOpportunity(client, oppId).catch(() => null)
      const base = `Opportunity: ${opp.opportunity_name ?? oppKey} — $${opp.amount ?? '?'}, closes ${opp.close_date ?? '?'}, engagement ${opp.engagement_level ?? '?'}, owner ${opp.owner?.name ?? '?'}`
      nodes.push({
        id: nodeIds.opportunity(oppKey),
        type: 'opportunity',
        text: oppFacts?.text ? `${base}. Sales AI status: ${oppFacts.text}` : base,
        props: {
          peopleaiOpportunityId: oppId, name: opp.opportunity_name, amount: opp.amount,
          closeDate: opp.close_date, engagementLevel: opp.engagement_level, owner: opp.owner?.name,
        },
      })
      edges.push({ organizationId, from: nodeIds.opportunity(oppKey), to: nodeIds.account(acctKey), rel: 'belongs_to' })
      opportunities++
    }
  }

  // Embed + persist in chunks so one huge batch doesn't blow the embeddings request.
  for (let i = 0; i < nodes.length; i += 64) {
    await commitGraph(organizationId, nodes.slice(i, i + 64), [])
  }
  if (edges.length) await commitGraph(organizationId, [], edges)

  return { accounts, opportunities }
}

export async function backfillOrganization(organizationId: string): Promise<BackfillResult> {
  if (!ragEnabled()) {
    return { accounts: 0, opportunities: 0, agents: 0, executions: 0, signals: 0, skipped: 'rag-disabled' }
  }

  const book = await indexSalesAiBook(organizationId)

  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: { not: 'DELETED' } },
    take: CAPS.agents,
    orderBy: { createdAt: 'desc' },
  })
  for (const agent of agents) {
    const meta = (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}) as Record<string, unknown>
    await indexAgent({
      id: agent.id, organizationId, objective: agent.objective, description: agent.description,
      title: (meta.title as string) || agent.description?.split('\n')[0] || 'Untitled agent',
    })
  }

  const executions = await prisma.agentExecution.findMany({
    where: { organizationId, status: 'completed' },
    take: CAPS.executions,
    orderBy: { startedAt: 'desc' },
    omit: { transcript: true },
  })
  for (const execution of executions) {
    await indexExecution({
      id: execution.id, organizationId, agentTaskId: execution.agentTaskId,
      signalId: execution.signalId, input: execution.input, output: execution.output, status: execution.status,
    })
  }

  const signals = await prisma.signal.findMany({
    where: { organizationId },
    take: CAPS.signals,
    orderBy: { receivedAt: 'desc' },
  })
  for (const signal of signals) {
    await indexSignal({
      id: signal.id, organizationId, type: signal.type,
      accountId: signal.accountId, opportunityId: signal.opportunityId, stakeholderId: signal.stakeholderId,
      payload: signal.payload,
    })
  }

  const result: BackfillResult = {
    accounts: book.accounts, opportunities: book.opportunities,
    agents: agents.length, executions: executions.length, signals: signals.length,
  }
  apiLogger.info('rag backfill complete', { organizationId, ...result })
  return result
}
