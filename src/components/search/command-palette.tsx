'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, CircleDashed, HelpCircle, Loader2, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'

type AgentResult = Pick<Agent, 'id' | 'title' | 'icon' | 'folder'>
type RunResult = { id: string; title: string; headline: string | null; status: string; startedAt: string }
type Result =
  | { kind: 'agent'; agent: AgentResult }
  | { kind: 'run'; run: RunResult }

function runStatusIcon(status: string) {
  switch (status.toLowerCase()) {
    case 'completed': return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
    case 'running': return <CircleDashed className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
    case 'waiting_for_input': return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" />
    default: return <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
  }
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [agents, setAgents] = useState<AgentResult[]>([])
  const [runs, setRuns] = useState<RunResult[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const requestId = useRef(0)

  const results = useMemo<Result[]>(() => [
    ...agents.map((agent) => ({ kind: 'agent' as const, agent })),
    ...runs.map((run) => ({ kind: 'run' as const, run })),
  ], [agents, runs])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setAgents([])
      setRuns([])
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setAgents([])
      setRuns([])
      setSearching(false)
      return
    }
    setSearching(true)
    const id = ++requestId.current
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { cache: 'no-store' })
        const data = await response.json()
        if (id !== requestId.current) return
        setAgents(data.agents || [])
        setRuns(data.runs || [])
        setActive(0)
      } finally {
        if (id === requestId.current) setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const select = useCallback((result: Result) => {
    onOpenChange(false)
    if (result.kind === 'agent') router.push(`/dashboard?agent=${result.agent.id}`)
    else router.push(`/dashboard?run=${result.run.id}`)
  }, [onOpenChange, router])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault()
      select(results[active])
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Search agents and runs</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          {searching ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : <Search className="h-4 w-4 text-gray-400" />}
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            placeholder="Search agents and runs..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="rounded border bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-400">ESC</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {agents.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Agents</div>
          )}
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-gray-100', active === index && 'bg-gray-100')}
              onMouseEnter={() => setActive(index)}
              onClick={() => select({ kind: 'agent', agent })}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-graphite-100 text-[11px] font-semibold uppercase leading-none text-graphite-700">
                {agent.icon || agent.title.trim().charAt(0) || 'A'}
              </span>
              <span className="flex-1 truncate">{agent.title}</span>
              {agent.folder && <span className="text-xs text-gray-400">{agent.folder}</span>}
            </button>
          ))}
          {runs.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Runs</div>
          )}
          {runs.map((run, index) => {
            const resultIndex = agents.length + index
            return (
              <button
                key={run.id}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-gray-100', active === resultIndex && 'bg-gray-100')}
                onMouseEnter={() => setActive(resultIndex)}
                onClick={() => select({ kind: 'run', run })}
              >
                {runStatusIcon(run.status)}
                <span className="flex-1 truncate">{run.headline || run.title}</span>
                <span className="shrink-0 text-xs text-gray-400">{new Date(run.startedAt).toLocaleDateString()}</span>
              </button>
            )
          })}
          {query.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-gray-500">No results for “{query.trim()}”.</p>
          )}
          {query.trim().length < 2 && (
            <p className="px-2 py-6 text-center text-sm text-gray-400">Type at least 2 characters to search.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
