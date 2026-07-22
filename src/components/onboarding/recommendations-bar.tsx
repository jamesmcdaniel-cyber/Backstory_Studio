'use client'

import { useEffect, useState } from 'react'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useProposals } from '@/components/providers/proposals-provider'
import { KIND_LABEL } from './proposal-shared'

const COLLAPSE_KEY = 'backstory:recs-collapsed'

/**
 * Compact home-page surface for AI recommendations: a single collapsible bar
 * showing a count, expanding to brief one-line rows. Each row opens the shared
 * detail popup for the full rationale; Accept stays a 1-click inline. Renders
 * nothing until there's a real recommendation.
 */
export function RecommendationsBar() {
  const { proposals, busyId, accept, openDetail } = useProposals()
  // Default collapsed so the surface never dominates the page; the count keeps
  // it discoverable. Preference persists across visits.
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) !== 'false')
    } catch {
      /* private mode — keep default */
    }
  }, [])

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      try { window.localStorage.setItem(COLLAPSE_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }

  if (!proposals.length) return null

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left hover:bg-gray-50"
      >
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900">Recommended for you</h3>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{proposals.length}</span>
        <ChevronDown className={cn('ml-auto h-4 w-4 text-gray-400 transition-transform', !collapsed && 'rotate-180')} />
      </button>

      {!collapsed && (
        <ul className="divide-y border-t">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                onClick={() => openDetail(proposal)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                  {KIND_LABEL[proposal.kind] ?? 'Suggestion'}
                </span>
                <span className="text-sm font-medium text-gray-900 group-hover:underline">{proposal.title}</span>
              </button>
              <button
                type="button"
                onClick={() => openDetail(proposal)}
                className="shrink-0 text-xs font-medium text-indigo-600 hover:underline"
              >
                Details
              </button>
              <button
                type="button"
                disabled={busyId === proposal.id}
                onClick={() => void accept(proposal)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" /> {proposal.kind === 'process_improvement' ? 'Open' : 'Accept'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
