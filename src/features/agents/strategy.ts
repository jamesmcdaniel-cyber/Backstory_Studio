/**
 * Strategize-mode heuristics + the goal/strategy prompt sections. Pure module
 * (no Prisma/LLM imports) so it is trivially unit-testable.
 */

export const STRATEGIZE_RETRIEVAL = { topK: 10, hops: 3 }

export function shouldStrategize(params: { objective: string; metadata: Record<string, unknown>; toolCount: number }): boolean {
  if (params.metadata.alwaysStrategize === true) return true
  if (params.objective.length > 1200) return true
  if (Number(params.metadata.maxTurns) > 16) return true
  if (params.toolCount > 25) return true
  return false
}

export function goalSection(goal: string | null | undefined): string {
  const trimmed = goal?.trim()
  if (!trimmed) return ''
  return `## Larger goal\nEverything you do this run should serve this goal: ${trimmed}\nWhen choices arise, pick the option that best advances it, and evaluate your final output against it.`
}

export function strategizeSection(): string {
  return [
    '## Think before acting',
    'This task is complex. Before calling ANY tool, produce a short numbered plan: the steps you will take, which tools each step needs, and what "done" looks like. State the plan in your first reply, then execute it.',
    'When a step fails or returns something unexpected, pause and revise the plan explicitly before continuing.',
  ].join('\n')
}
