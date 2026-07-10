// Derives the run-level `waiting` object exposed by the runs API from a run's
// status + steps. A waiting agent step persists its pause reason in
// output.waiting ({ kind, question?, approvalId? }); this surfaces what the
// run is blocked on so reply/approval UIs know what to render.

export type RunWaiting = { nodeId: string; kind: 'input' | 'approval'; question?: string }

export function deriveRunWaiting(
  status: string,
  steps: { nodeId: string; status: string; output?: unknown }[],
): RunWaiting | null {
  if (status !== 'waiting') return null
  const step = steps.find((s) => s.status === 'waiting')
  if (!step) return null
  const info = (step.output as { waiting?: { kind?: string; question?: string } } | null | undefined)?.waiting
  return {
    nodeId: step.nodeId,
    kind: info?.kind === 'approval' ? ('approval' as const) : ('input' as const),
    question: info?.question,
  }
}
