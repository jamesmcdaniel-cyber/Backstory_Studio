/**
 * Trigger-level filter: gate a run BEFORE it starts. Returns true when the
 * trigger has no condition, or its clauses pass against the incoming payload.
 * Reuses the flow condition evaluator so operators/templating match condition
 * nodes exactly. A run that fails the gate is never created (no FlowRun row).
 */
import { evalClause } from '@/features/flows/context'
import type { FlowContext } from '@/features/flows/context'

type Clause = { left: string; op: string; right: string }
type TriggerCondition = { match?: 'all' | 'any'; clauses?: Clause[] }

export function triggerConditionPasses(trigger: unknown, input: unknown): boolean {
  const condition = (trigger as { condition?: TriggerCondition } | null | undefined)?.condition
  const clauses = Array.isArray(condition?.clauses) ? condition!.clauses : []
  if (clauses.length === 0) return true
  const ctx = { trigger: { input }, step: {}, variables: {} } as FlowContext
  // Fail CLOSED on a malformed condition (e.g. a non-string clause operand that
  // makes evalClause throw): skip the run rather than 500 the webhook / abort a
  // signal or cron loop. The trigger node's data is z.any(), so the shape isn't
  // guaranteed valid at this point.
  try {
    const results = clauses.map((clause) => evalClause(clause as never, ctx))
    return (condition?.match ?? 'all') === 'any' ? results.some(Boolean) : results.every(Boolean)
  } catch {
    return false
  }
}
