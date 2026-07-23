import { COACHING_REPORTS } from './coaching'
import { PLATFORM_REPORTS } from './platform'
import { REVENUE_REPORTS } from './revenue'
import { STRATEGIC_REPORTS } from './strategic'

/**
 * Illustrative output for every built-in template, keyed by template id.
 * Each one is a full house-format HTML report — the same document a live run
 * produces (src/features/agents/report-format.ts) — so what the gallery
 * advertises is exactly what the agent delivers.
 */
export const EXAMPLE_REPORTS: Record<string, string> = {
  ...REVENUE_REPORTS,
  ...COACHING_REPORTS,
  ...PLATFORM_REPORTS,
  ...STRATEGIC_REPORTS,
}

export { report, actionPlan, high, med, num, dim } from './report-builder'
export type { ReportSpec, Section, Cell } from './report-builder'
