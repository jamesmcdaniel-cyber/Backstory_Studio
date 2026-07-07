'use client'

import { X, Trash2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CONDITION_OPS, type FlowNode, type ConditionOp, type ConditionClause } from '@/lib/flows/graph'

type EditableType = Extract<FlowNode['type'], 'agent' | 'condition' | 'loop' | 'parallel' | 'stop'>
const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'condition', label: 'If / else' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'stop', label: 'Stop' },
]

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const smallField =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Normalize a condition node's data to the clause list the editor works with. */
function clausesOf(data: Extract<FlowNode, { type: 'condition' }>['data']): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

export function StepDrawer({
  node,
  agents,
  upstreamNodeIds,
  insideLoop,
  onChange,
  onChangeType,
  onAddStep,
  onDelete,
  onClose,
}: {
  node: FlowNode
  agents: { id: string; title: string }[]
  upstreamNodeIds: string[]
  insideLoop: boolean
  onChange: (node: FlowNode) => void
  onChangeType: (type: EditableType) => void
  onAddStep?: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const isTrigger = node.type === 'trigger'
  const tokens = [
    '{{trigger.input}}',
    ...upstreamNodeIds.map((id) => `{{step.${id}.output}}`),
    ...(insideLoop ? ['{{item}}', '{{loop.index}}'] : []),
  ]

  // Label editing (all non-trigger nodes carry an optional label).
  const setLabel = (label: string) => onChange({ ...node, data: { ...node.data, label } } as FlowNode)

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{isTrigger ? 'Trigger' : 'Configure step'}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 p-4">
        {isTrigger ? (
          <div>
            <label className={labelClass}>Trigger type</label>
            <select
              className={fieldClass}
              value={(node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'}
              onChange={(e) => onChange({ ...node, data: { trigger: { type: e.target.value } } })}
            >
              <option value="manual">Manual / on run</option>
              <option value="schedule">Schedule</option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">Set the flow&apos;s schedule from the top bar. Signal triggers are coming soon.</p>
          </div>
        ) : (
          <>
            <div>
              <label className={labelClass}>Step type</label>
              <select className={fieldClass} value={node.type} onChange={(e) => onChangeType(e.target.value as EditableType)}>
                {NODE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Label (optional)</label>
              <input
                className={fieldClass}
                value={(node.data as { label?: string }).label ?? ''}
                placeholder="A short name for this step"
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label className={labelClass}>Agent</label>
              <select className={fieldClass} value={node.data.agentId} onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}>
                <option value="">Select an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              {agents.length === 0 && <p className="mt-1.5 text-xs text-amber-600">No agents yet — create one first.</p>}
            </div>
            <div>
              <label className={labelClass}>Input</label>
              <textarea
                rows={4}
                className={fieldClass}
                value={node.data.input ?? ''}
                placeholder="{{trigger.input}}"
                onChange={(e) => onChange({ ...node, data: { ...node.data, input: e.target.value } })}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tokens.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => onChange({ ...node, data: { ...node.data, input: `${node.data.input ?? ''}${token}` } })}
                    className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-indigo-300 hover:text-indigo-600"
                  >
                    {token}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>On error</label>
                <select
                  className={`${smallField} w-full`}
                  value={node.data.onError ?? 'stop'}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, onError: e.target.value as 'stop' | 'continue' } })}
                >
                  <option value="stop">Stop flow</option>
                  <option value="continue">Continue</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Retries</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  className={`${smallField} w-full`}
                  value={node.data.retries ?? 0}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, retries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } })}
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>Timeout (seconds, optional)</label>
              <input
                type="number"
                min={1}
                className={fieldClass}
                value={node.data.timeoutMs ? Math.round(node.data.timeoutMs / 1000) : ''}
                placeholder="No timeout"
                onChange={(e) => {
                  const secs = Number(e.target.value)
                  onChange({ ...node, data: { ...node.data, timeoutMs: secs > 0 ? secs * 1000 : undefined } })
                }}
              />
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Match</label>
              <select
                className={fieldClass}
                value={node.data.match ?? 'all'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data), left: undefined, op: undefined, right: undefined } })}
              >
                <option value="all">All conditions (AND)</option>
                <option value="any">Any condition (OR)</option>
              </select>
            </div>
            {clausesOf(node.data).map((clause, i) => {
              const clauses = clausesOf(node.data)
              const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next, left: undefined, op: undefined, right: undefined } })
              return (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <input
                    className={`${smallField} w-full`}
                    value={clause.left}
                    placeholder="{{step.n1.output.score}}"
                    onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, left: e.target.value } : c)))}
                  />
                  <div className="flex gap-1.5">
                    <select
                      className={smallField}
                      value={clause.op}
                      onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}
                    >
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${smallField} flex-1`}
                      value={clause.right}
                      placeholder="80"
                      onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, right: e.target.value } : c)))}
                    />
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }], left: undefined, op: undefined, right: undefined } })}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Over (a list)</label>
              <input className={fieldClass} value={node.data.over} placeholder="{{step.n1.output}}" onChange={(e) => onChange({ ...node, data: { ...node.data, over: e.target.value } })} />
              <p className="mt-1.5 text-xs text-muted-foreground">Runs the nested steps once per item. Click an indented card to edit it.</p>
            </div>
            <div>
              <label className={labelClass}>At a time</label>
              <input
                type="number"
                min={1}
                max={20}
                className={fieldClass}
                value={node.data.concurrency ?? 3}
                onChange={(e) => onChange({ ...node, data: { ...node.data, concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })}
              />
            </div>
            {onAddStep && (
              <Button variant="outline" size="sm" className="w-full" onClick={onAddStep}>
                <Plus className="mr-1.5 h-4 w-4" /> Add step to loop
              </Button>
            )}
          </div>
        )}

        {node.type === 'parallel' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Runs {node.data.branches.length} branch{node.data.branches.length === 1 ? '' : 'es'} at once and merges their outputs. Click an indented card to edit a branch step.
            </p>
            {onAddStep && (
              <Button variant="outline" size="sm" className="w-full" onClick={onAddStep}>
                <Plus className="mr-1.5 h-4 w-4" /> Add parallel branch
              </Button>
            )}
          </div>
        )}

        {node.type === 'stop' && (
          <div>
            <label className={labelClass}>Reason (optional)</label>
            <input className={fieldClass} value={node.data.reason ?? ''} placeholder="Why the flow stops here" onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })} />
            <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped.</p>
          </div>
        )}
      </div>

      {!isTrigger && (
        <div className="border-t border-border p-4">
          <Button variant="outline" className="w-full text-red-600 hover:text-red-700" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Delete step
          </Button>
        </div>
      )}
    </div>
  )
}
