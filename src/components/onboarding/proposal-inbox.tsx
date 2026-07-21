'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'

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

const KIND_LABEL: Record<string, string> = {
  agent_template: 'New agent',
  flow_template: 'New flow',
  process_improvement: 'Improve something you already run',
}

/** Compact, at-a-glance preview of what accepting will provision. */
function ProposalPreview({ proposal }: { proposal: ProposalCard }) {
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
      {improvement && <p className="line-clamp-3 text-xs text-gray-600">{improvement}</p>}
      {instructions && <p className="line-clamp-2 text-xs text-gray-500">{instructions}</p>}
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

/** Poll cadence + budget while generation may still be landing proposals. */
const POLL_MS = 5_000
const POLL_BUDGET = 24 // ~2 minutes, then the inbox goes static until remount

/**
 * "Your data takes shape" — the review inbox for AI-generated template
 * proposals. Accepting a template-kind proposal adds it to the org catalogue;
 * accepting an improvement opens the flow/agent it targets; dismissing is
 * terminal. Rows disappear optimistically and reappear with an honest toast
 * when the server disagrees.
 */
export function ProposalInbox({
  generating,
  hideWhenEmpty = false,
  title,
}: {
  generating: boolean
  hideWhenEmpty?: boolean
  /** When set, the list renders under this heading in a self-padded block (for
   *  persistent surfaces like the dashboard). */
  title?: string
}) {
  const [proposals, setProposals] = useState<ProposalCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const polls = useRef(0)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const data = await fetch('/api/template-proposals', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
      if (!alive) return
      if (data?.success) setProposals((data.proposals ?? []).filter((p: ProposalCard) => p.status === 'open'))
      setLoaded(true)
    }
    void load()
    const timer = window.setInterval(() => {
      polls.current += 1
      if (polls.current > POLL_BUDGET) {
        window.clearInterval(timer)
        return
      }
      void load()
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const remove = (id: string) => setProposals((prev) => prev.filter((proposal) => proposal.id !== id))
  const restore = (proposal: ProposalCard) => setProposals((prev) => (prev.some((p) => p.id === proposal.id) ? prev : [proposal, ...prev]))

  const accept = async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
    remove(proposal.id)
    try {
      const response = await fetch(`/api/template-proposals/${proposal.id}/accept`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        restore(proposal)
        toast.error(data.error || 'Could not accept that suggestion.')
        return
      }
      if (proposal.kind === 'process_improvement') {
        const target = data.open as { targetType?: string; targetId?: string } | null
        if (target?.targetType === 'flow' && target.targetId) {
          window.open(`/flows/${target.targetId}`, '_blank', 'noopener')
        } else if (target?.targetType === 'agent' && target.targetId) {
          window.open(`/dashboard?agent=${target.targetId}`, '_blank', 'noopener')
        }
        toast.success('Opened what it wants to improve.')
        return
      }
      // 1-click: accept provisioned a LIVE artifact — land the user on it.
      if (typeof data.agentId === 'string' && data.agentId) {
        const missing = Array.isArray(data.missingIntegrations) ? (data.missingIntegrations as string[]) : []
        toast.success(missing.length ? `Agent created — connect ${missing.join(', ')} to fully activate it.` : 'Agent created and ready to run.')
        window.location.href = `/dashboard?agent=${data.agentId}`
        return
      }
      if (typeof data.flowId === 'string' && data.flowId) {
        toast.success('Flow created and wired — ready to run.')
        window.location.href = `/flows/${data.flowId}`
        return
      }
      toast.success('Added to your catalogue.')
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = async (proposal: ProposalCard) => {
    setBusyId(proposal.id)
    remove(proposal.id)
    try {
      const response = await fetch(`/api/template-proposals/${proposal.id}/dismiss`, { method: 'POST' })
      if (!response.ok) {
        restore(proposal)
        toast.error('Could not dismiss that suggestion.')
      }
    } finally {
      setBusyId(null)
    }
  }

  // Persistent surfaces (dashboard) render nothing until there's a real
  // recommendation — no "checking…" or "no suggestions" chrome.
  if (hideWhenEmpty && !proposals.length) return null
  if (!loaded) {
    return <p className="text-sm text-gray-500">Checking for suggestions…</p>
  }
  if (!proposals.length) {
    return (
      <p className="text-sm leading-6 text-gray-500">
        {generating
          ? 'Your AI is still learning — this updates as it finds patterns.'
          : 'No suggestions right now — you can build your own anytime.'}
      </p>
    )
  }
  const list = (
    <ul className="space-y-3">
      {proposals.map((proposal) => (
        <li key={proposal.id} className="rounded-lg border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                <Sparkles className="h-3 w-3" /> {KIND_LABEL[proposal.kind] ?? 'Suggestion'}
              </span>
              <p className="mt-1.5 text-sm font-semibold text-gray-900">{proposal.title}</p>
              <p className="mt-1 text-sm leading-5 text-gray-600">{proposal.rationale}</p>
              <ProposalPreview proposal={proposal} />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busyId === proposal.id}
              onClick={() => void accept(proposal)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50',
              )}
            >
              <Check className="h-3.5 w-3.5" /> {proposal.kind === 'process_improvement' ? 'Open and improve' : 'Accept'}
            </button>
            <button
              type="button"
              disabled={busyId === proposal.id}
              onClick={() => void dismiss(proposal)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
  if (!title) return list
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      {list}
    </div>
  )
}
