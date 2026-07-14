/**
 * Stage-1 progress toward the auto-template gate: templates start generating
 * once `required` integrations are connected. Pure so the copy/percent logic
 * is unit-testable apart from the connect page.
 */
export function gateMeter(connected: number, required: number): {
  percent: number
  label: string
  meetsGate: boolean
} {
  const safeRequired = Math.max(1, required)
  const clamped = Math.max(0, Math.min(connected, safeRequired))
  const meetsGate = connected >= safeRequired
  return {
    percent: Math.round((clamped / safeRequired) * 100),
    label: meetsGate
      ? 'Your tools are connected — your AI is learning from them.'
      : `${clamped} of ${safeRequired} tools connected`,
    meetsGate,
  }
}
