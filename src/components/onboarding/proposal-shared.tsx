'use client'

export type ProposalCard = {
  id: string
  title: string
  rationale: string
  kind: string
  status: string
  // Preview payload (returned by /api/template-proposals): what the user is
  // about to provision, so accept is an informed 1-click, not a leap of faith.
  configuration?: Record<string, unknown> | null
  sourceEvidence?: Record<string, unknown> | null
}

export const KIND_LABEL: Record<string, string> = {
  agent_template: 'New agent',
  flow_template: 'New flow',
  process_improvement: 'Improve something you already run',
}

/**
 * Preview of what accepting will provision. `clamp` keeps it tight in inline
 * lists; the detail popup passes clamp={false} to show everything.
 */
export function ProposalPreview({ proposal, clamp = true }: { proposal: ProposalCard; clamp?: boolean }) {
  const config = (proposal.configuration ?? {}) as Record<string, unknown>
  const evidence = (proposal.sourceEvidence ?? {}) as Record<string, unknown>
  const integrations = Array.isArray(config.integrations)
    ? (config.integrations as unknown[]).filter((i): i is string => typeof i === 'string')
    : []
  const instructions = typeof config.instructions === 'string' ? config.instructions.trim() : ''
  const schedule = typeof config.schedule === 'string' && config.schedule ? config.schedule : null
  const confidence = typeof evidence.confidence === 'number' ? Math.round(evidence.confidence * 100) : null
  const improvement = proposal.kind === 'process_improvement' && typeof config.notes === 'string' ? config.notes.trim() : ''
  const hasPreview = integrations.length || instructions || schedule || confidence !== null || improvement
  if (!hasPreview) return null
  return (
    <div className="mt-2 space-y-1.5 border-t pt-2">
      {improvement && <p className={clamp ? 'line-clamp-3 text-xs text-gray-600' : 'text-xs text-gray-600'}>{improvement}</p>}
      {instructions && <p className={clamp ? 'line-clamp-2 text-xs text-gray-500' : 'text-xs text-gray-500'}>{instructions}</p>}
      {integrations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {integrations.map((i) => (
            <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">{i}</span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] text-gray-400">
        {schedule && <span>Runs {schedule}</span>}
        {confidence !== null && <span>· {confidence}% confidence</span>}
      </div>
    </div>
  )
}
