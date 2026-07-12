/**
 * Usage profile: a structured, org-scoped summary of a workspace's integration
 * activity that the auto-template generation engine (sub-project C) reasons over.
 *
 * Two layers:
 *  - `aggregateUsage` is a PURE, deterministic aggregator over `UsageRow`s
 *    (node:testable without a DB).
 *  - `buildUsageProfile` is a thin, bounded DB read that maps AuditEvent rows
 *    (and, for thin orgs, WorkflowStep rows) into `UsageRow`s and calls it.
 *
 * Provider/tool extraction mirrors how `recordAudit` stores activity:
 *   AuditEvent.resourceType = provider (e.g. 'slack', 'people.ai'), .tool = tool.
 * WorkflowStep.node is the '<provider>.<tool>' encoding written by the agent
 * loop; we split on the LAST dot so providers that contain a dot (e.g.
 * 'people.ai') survive.
 */

import { prisma } from '@/lib/prisma'

export type UsageRow = { provider: string; tool: string; runId: string | null; at: string }

export type UsageProfile = {
  providers: { provider: string; calls: number }[]
  topTools: { provider: string; tool: string; calls: number }[]
  coOccurrence: { providers: string[]; runs: number }[]
  sequences: { steps: string[]; count: number }[]
  runCount: number
  windowDays: number
}

/** Window: last 90 days AND at most the most-recent 500 audit rows (whichever tighter). */
export const USAGE_WINDOW_DAYS = 90
export const MAX_AUDIT_ROWS = 500
/**
 * Below this many audit rows an org is "thin" and we fold in WorkflowStep-derived
 * rows (from executions not already represented in the audit slice) so few-run
 * orgs still get signal.
 */
export const THIN_AUDIT_ROW_THRESHOLD = 20

const TOP_TOOLS_CAP = 25
const CO_OCCURRENCE_CAP = 25
const SEQUENCES_CAP = 25

// Composite map keys are JSON-encoded tuples/arrays: collision-free for any
// provider/tool string, pure-ASCII, and reversible via JSON.parse.
const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * PURE aggregation. Deterministic: every output array is sorted desc by count
 * with a secondary sort by the JSON key string so results are stable across any
 * input ordering. Rows with an empty provider are ignored.
 */
export function aggregateUsage(rows: UsageRow[], windowDays: number = USAGE_WINDOW_DAYS): UsageProfile {
  const clean = rows.filter((r) => r.provider)

  // providers: rows per provider.
  const providerCounts = new Map<string, number>()
  // topTools: rows per (provider, tool), keyed by JSON [provider, tool].
  const toolCounts = new Map<string, number>()
  // runs: ordered rows per non-null runId.
  const runs = new Map<string, UsageRow[]>()

  for (const r of clean) {
    providerCounts.set(r.provider, (providerCounts.get(r.provider) ?? 0) + 1)
    const toolKey = JSON.stringify([r.provider, r.tool])
    toolCounts.set(toolKey, (toolCounts.get(toolKey) ?? 0) + 1)
    if (r.runId !== null) {
      const bucket = runs.get(r.runId)
      if (bucket) bucket.push(r)
      else runs.set(r.runId, [r])
    }
  }

  const providers = [...providerCounts.entries()]
    .map(([provider, calls]) => ({ provider, calls }))
    .sort((a, b) => b.calls - a.calls || asc(a.provider, b.provider))

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || asc(a[0], b[0]))
    .slice(0, TOP_TOOLS_CAP)
    .map(([key, calls]) => {
      const [provider, tool] = JSON.parse(key) as [string, string]
      return { provider, tool, calls }
    })

  // co-occurrence: count runs sharing each distinct-provider SET (size >= 2).
  const setCounts = new Map<string, number>()
  // sequences: count identical distinct-adjacent provider chains (length >= 2).
  const seqCounts = new Map<string, number>()

  for (const bucket of runs.values()) {
    const distinctProviders = [...new Set(bucket.map((r) => r.provider))].sort()
    if (distinctProviders.length >= 2) {
      const setKey = JSON.stringify(distinctProviders)
      setCounts.set(setKey, (setCounts.get(setKey) ?? 0) + 1)
    }

    // Order by `at`, tie-break by provider then tool so a shuffled input of the
    // same rows yields the same chain.
    const ordered = [...bucket].sort(
      (a, b) => asc(a.at, b.at) || asc(a.provider, b.provider) || asc(a.tool, b.tool),
    )
    const chain: string[] = []
    for (const r of ordered) {
      if (chain.length === 0 || chain[chain.length - 1] !== r.provider) chain.push(r.provider)
    }
    if (chain.length >= 2) {
      const seqKey = JSON.stringify(chain)
      seqCounts.set(seqKey, (seqCounts.get(seqKey) ?? 0) + 1)
    }
  }

  const coOccurrence = [...setCounts.entries()]
    .sort((a, b) => b[1] - a[1] || asc(a[0], b[0]))
    .slice(0, CO_OCCURRENCE_CAP)
    .map(([key, runsCount]) => ({ providers: JSON.parse(key) as string[], runs: runsCount }))

  const sequences = [...seqCounts.entries()]
    .sort((a, b) => b[1] - a[1] || asc(a[0], b[0]))
    .slice(0, SEQUENCES_CAP)
    .map(([key, count]) => ({ steps: JSON.parse(key) as string[], count }))

  return { providers, topTools, coOccurrence, sequences, runCount: runs.size, windowDays }
}

const normProvider = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()
const normTool = (v: string | null | undefined): string => (v ?? '').trim()

/** Split a WorkflowStep.node ('<provider>.<tool>') on the LAST dot. */
function splitNode(node: string): { provider: string; tool: string } | null {
  const idx = node.lastIndexOf('.')
  if (idx <= 0 || idx === node.length - 1) return null // no dot, or nothing on a side
  return { provider: normProvider(node.slice(0, idx)), tool: normTool(node.slice(idx + 1)) }
}

/**
 * DB wrapper: org-scoped, bounded read of integration activity -> `UsageProfile`.
 *
 * Source of truth is AuditEvent (resourceType = provider, tool = tool, executionId
 * = the run/execution id), windowed to the last {@link USAGE_WINDOW_DAYS} days and
 * capped at the most-recent {@link MAX_AUDIT_ROWS} rows (whichever is tighter).
 *
 * When audit coverage is thin ({@link THIN_AUDIT_ROW_THRESHOLD}), we ALSO fold in
 * WorkflowStep rows (node = '<provider>.<tool>') from executions NOT already
 * represented in the audit slice, so few-run orgs still get signal without
 * double-counting the same execution. FlowRunStep is intentionally not read: it
 * carries only a graph nodeId (no provider/tool), and flow tool calls are already
 * captured in AuditEvent (executionId = the flow run id).
 */
export async function buildUsageProfile(organizationId: string): Promise<UsageProfile> {
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const auditRows = await prisma.auditEvent.findMany({
    where: { organizationId, createdAt: { gte: since }, resourceType: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: MAX_AUDIT_ROWS,
    select: { resourceType: true, tool: true, executionId: true, createdAt: true },
  })

  const rows: UsageRow[] = auditRows
    .map((r) => ({
      provider: normProvider(r.resourceType),
      tool: normTool(r.tool),
      runId: r.executionId ?? null,
      at: r.createdAt.toISOString(),
    }))
    .filter((r) => r.provider)

  // Thin-org fallback: fold in WorkflowStep-derived rows from executions the
  // audit slice does not already cover.
  if (auditRows.length < THIN_AUDIT_ROW_THRESHOLD) {
    const seenRuns = new Set(rows.map((r) => r.runId).filter((id): id is string => id !== null))
    const steps = await prisma.workflowStep.findMany({
      where: { createdAt: { gte: since }, execution: { organizationId } },
      orderBy: { createdAt: 'desc' },
      take: MAX_AUDIT_ROWS,
      select: { node: true, executionId: true, createdAt: true },
    })
    for (const s of steps) {
      if (seenRuns.has(s.executionId)) continue
      const parsed = splitNode(s.node)
      if (!parsed || !parsed.provider || !parsed.tool) continue
      rows.push({ provider: parsed.provider, tool: parsed.tool, runId: s.executionId, at: s.createdAt.toISOString() })
    }
  }

  return aggregateUsage(rows, USAGE_WINDOW_DAYS)
}
