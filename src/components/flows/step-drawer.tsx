'use client'

import { X, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CONDITION_OPS, type FlowNode, type ConditionOp } from '@/lib/flows/graph'

const NODE_TYPES: { value: Extract<FlowNode['type'], 'agent' | 'condition' | 'loop'>; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'condition', label: 'If / else' },
  { value: 'loop', label: 'For each' },
]

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export function StepDrawer({
  node,
  agents,
  upstreamNodeIds,
  insideLoop,
  onChange,
  onChangeType,
  onDelete,
  onClose,
}: {
  node: FlowNode
  agents: { id: string; title: string }[]
  upstreamNodeIds: string[]
  insideLoop: boolean
  onChange: (node: FlowNode) => void
  onChangeType: (type: Extract<FlowNode['type'], 'agent' | 'condition' | 'loop'>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const isTrigger = node.type === 'trigger'

  const tokens = [
    '{{trigger.input}}',
    ...upstreamNodeIds.map((id) => `{{step.${id}.output}}`),
    ...(insideLoop ? ['{{item}}'] : []),
  ]

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
            <p className="mt-2 text-xs text-muted-foreground">
              Set the flow&apos;s schedule from the top bar. Signal triggers are coming soon.
            </p>
          </div>
        ) : (
          <div>
            <label className={labelClass}>Step type</label>
            <select className={fieldClass} value={node.type} onChange={(e) => onChangeType(e.target.value as 'agent' | 'condition' | 'loop')}>
              {NODE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label className={labelClass}>Agent</label>
              <select
                className={fieldClass}
                value={node.data.agentId}
                onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}
              >
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
            <div>
              <label className={labelClass}>On error</label>
              <select
                className={fieldClass}
                value={node.data.onError ?? 'stop'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, onError: e.target.value as 'stop' | 'continue' } })}
              >
                <option value="stop">Stop the flow</option>
                <option value="continue">Continue to the next step</option>
              </select>
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Left (template)</label>
              <input
                className={fieldClass}
                value={node.data.left}
                placeholder="{{step.n1.output.score}}"
                onChange={(e) => onChange({ ...node, data: { ...node.data, left: e.target.value } })}
              />
            </div>
            <div>
              <label className={labelClass}>Operator</label>
              <select
                className={fieldClass}
                value={node.data.op}
                onChange={(e) => onChange({ ...node, data: { ...node.data, op: e.target.value as ConditionOp } })}
              >
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Right (value)</label>
              <input
                className={fieldClass}
                value={node.data.right}
                placeholder="80"
                onChange={(e) => onChange({ ...node, data: { ...node.data, right: e.target.value } })}
              />
            </div>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Over (a list)</label>
              <input
                className={fieldClass}
                value={node.data.over}
                placeholder="{{step.n1.output}}"
                onChange={(e) => onChange({ ...node, data: { ...node.data, over: e.target.value } })}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">Runs the nested step once per item. Edit it by clicking the indented card.</p>
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
