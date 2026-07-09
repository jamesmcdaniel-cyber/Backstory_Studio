'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import {
  Bot,
  CalendarDays,
  CircleStop,
  FileText,
  Filter,
  GitBranch,
  Globe,
  Hash,
  Mail,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  Repeat,
  Rows3,
  SlidersHorizontal,
  Split,
  ToggleLeft,
  Trash2,
  Type,
  Wrench,
  Zap,
} from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import { CONDITION_OPS, FIELD_TYPES, type ConditionClause, type ConditionOp, type FlowNode, type OutputField, type TriggerInputField } from '@/lib/flows/graph'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import type { ToolCatalog } from './step-drawer'
import { AdvancedParamsSection } from './advanced-params'
import { DataTree } from './data-tree'
import { insertAtCaret } from './insert-token'
import type { DataField } from '@/lib/flows/datatree'

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped'

type Agent = { id: string; title: string }
type TriggerData = { type?: 'manual' | 'schedule' | 'webhook' | 'signal'; inputFields?: TriggerInputField[]; input?: string }
type KeyValueRow = { key: string; value: string }
type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'

const NODE_ICON: Record<FlowNode['type'], typeof Bot> = {
  trigger: Zap,
  agent: Bot,
  condition: GitBranch,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  tool: Wrench,
  http: Globe,
  transform: SlidersHorizontal,
  filter: Filter,
  switch: Split,
}

const NODE_TONE: Record<FlowNode['type'], string> = {
  trigger: 'bg-blue-600 text-white',
  agent: 'bg-slate-900 text-white',
  http: 'bg-emerald-600 text-white',
  tool: 'bg-orange-500 text-white',
  condition: 'bg-amber-500 text-white',
  loop: 'bg-sky-500 text-white',
  parallel: 'bg-cyan-600 text-white',
  stop: 'bg-red-500 text-white',
  transform: 'bg-violet-500 text-white',
  filter: 'bg-lime-600 text-white',
  switch: 'bg-fuchsia-600 text-white',
}

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
}

const INPUT_TYPES: {
  id: InputKind
  label: string
  description: string
  name: string
  fieldType: OutputField['type']
  icon: typeof Type
  tone: string
}[] = [
  { id: 'text', label: 'Text', description: 'Please enter your input', name: 'text', fieldType: 'string', icon: Type, tone: 'bg-purple-500 text-white' },
  { id: 'yesno', label: 'Yes / No', description: 'Choose yes or no.', name: 'yesNo', fieldType: 'boolean', icon: ToggleLeft, tone: 'bg-indigo-500 text-white' },
  { id: 'file', label: 'File', description: 'Upload or provide file data.', name: 'file', fieldType: 'object', icon: FileText, tone: 'bg-slate-700 text-white' },
  { id: 'email', label: 'Email', description: 'Enter an email address.', name: 'email', fieldType: 'string', icon: Mail, tone: 'bg-green-600 text-white' },
  { id: 'number', label: 'Number', description: 'Enter a number.', name: 'number', fieldType: 'number', icon: Hash, tone: 'bg-orange-500 text-white' },
  { id: 'date', label: 'Date', description: 'Enter a date.', name: 'date', fieldType: 'string', icon: CalendarDays, tone: 'bg-rose-500 text-white' },
]

const controlClass =
  'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const textareaClass =
  'min-h-[92px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerData(node: Extract<FlowNode, { type: 'trigger' }>): TriggerData {
  return isRecord(node.data.trigger) ? (node.data.trigger as TriggerData) : { type: 'manual' }
}

function inputTypeForField(field: OutputField) {
  const text = `${field.name} ${field.description ?? ''}`.toLowerCase()
  if (field.type === 'boolean') return INPUT_TYPES.find((type) => type.id === 'yesno')!
  if (field.type === 'number') return INPUT_TYPES.find((type) => type.id === 'number')!
  if (text.includes('email')) return INPUT_TYPES.find((type) => type.id === 'email')!
  if (text.includes('date')) return INPUT_TYPES.find((type) => type.id === 'date')!
  if (field.type === 'object' || field.type === 'array' || text.includes('file')) return INPUT_TYPES.find((type) => type.id === 'file')!
  return INPUT_TYPES.find((type) => type.id === 'text')!
}

function uniqueFieldName(base: string, fields: OutputField[]): string {
  const names = new Set(fields.map((field) => field.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

function parseKeyValueRows(value?: string): KeyValueRow[] {
  if (!value?.trim()) return [{ key: '', value: '' }]
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) {
      const rows = Object.entries(parsed).map(([key, raw]) => ({
        key,
        value: typeof raw === 'string' ? raw : JSON.stringify(raw),
      }))
      return rows.length ? rows : [{ key: '', value: '' }]
    }
  } catch {
    return [{ key: '', value }]
  }
  return [{ key: '', value }]
}

function serializeKeyValueRows(rows: KeyValueRow[]): string {
  const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const)
  if (!entries.length) return ''
  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

function defaultAgentInput(value?: string): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed === 'Use this flow input:\n{{trigger.input}}' || trimmed === 'Process this item:\n{{item}}'
}

function firstClause(node: Extract<FlowNode, { type: 'condition' | 'filter' }>): ConditionClause {
  if (node.data.clauses?.[0]) return node.data.clauses[0]
  if (node.type === 'condition') {
    return { left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }
  }
  return { left: '', op: 'contains', right: '' }
}

function transformFields(node: Extract<FlowNode, { type: 'transform' }>): { name: string; value: string }[] {
  return node.data.fields.length ? node.data.fields : [{ name: '', value: '' }]
}

function switchFirstCase(node: Extract<FlowNode, { type: 'switch' }>) {
  return node.data.cases[0] ?? { id: 'case1', left: '', op: 'contains' as ConditionOp, right: '' }
}

function selectedTool(connectionId: string, toolName: string, toolCatalog: ToolCatalog) {
  const connection = toolCatalog.find((entry) => entry.id === connectionId)
  const tool = connection?.tools.find((entry) => entry.name === toolName)
  return { connection, tool }
}

function stopEvent(event: React.MouseEvent | React.FocusEvent) {
  event.stopPropagation()
}

type TokenTarget = {
  el: HTMLInputElement | HTMLTextAreaElement
  read: (node: FlowNode) => string
  write: (node: FlowNode, value: string) => FlowNode
}
export type RegisterTokenTarget = (
  read: (node: FlowNode) => string,
  write: (node: FlowNode, value: string) => FlowNode,
) => (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void

export function StepCard({
  node,
  index,
  title,
  subtitle,
  status,
  selected,
  agents,
  toolCatalog,
  dataFields,
  onChange,
  onClick,
  onRefreshAgents,
}: {
  node: FlowNode
  index?: number
  title: string
  subtitle?: string
  status?: StepStatus
  selected?: boolean
  agents: Agent[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  onChange?: (node: FlowNode) => void
  onClick?: () => void
  onRefreshAgents?: () => void
}) {
  const Icon = NODE_ICON[node.type]
  const update = (updated: FlowNode) => onChange?.(updated)
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onClick?.()
  }
  const nodeRef = useRef(node)
  nodeRef.current = node
  const tokenTargetRef = useRef<TokenTarget | null>(null)
  const registerTokenTarget: RegisterTokenTarget = (read, write) => (event) => {
    tokenTargetRef.current = { el: event.currentTarget, read, write }
  }
  const insertToken = (token: string) => {
    const target = tokenTargetRef.current
    if (!target) return
    const current = target.read(nodeRef.current)
    onChange?.(target.write(nodeRef.current, insertAtCaret(current, token, target.el)))
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onRootKeyDown}
      className={cn(
        'w-full rounded-[18px] border bg-white text-left shadow-[0_2px_10px_rgba(15,23,42,0.08)] outline-none transition-all duration-fast',
        'hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,0.12)] focus-visible:ring-2 focus-visible:ring-blue-200',
        selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-5 px-5 py-5">
        <span className={cn('flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-lg', NODE_TONE[node.type])}>
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {typeof index === 'number' && <span className="text-xs font-semibold text-slate-400">{index}</span>}
            <h3 className="truncate text-lg font-semibold text-slate-950">{title}</h3>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</p>}
        </div>
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
            {status}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClick?.()
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 sm:flex"
          aria-label="Open step settings"
          title="Open step settings"
        >
          <PanelRight className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          aria-label="More step options"
          title="More options are in the settings panel"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </div>
      <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-slate-200 px-5 py-4">
        {renderNodeBody({ node, agents, toolCatalog, update, onRefreshAgents, registerTokenTarget })}
        {selected && dataFields && dataFields.length > 0 && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <DataTree
              fields={dataFields}
              onInsert={insertToken}
              title="Insert data from previous steps"
              emptyMessage="No earlier step data is available yet."
            />
          </div>
        )}
      </div>
    </div>
  )
}

function renderNodeBody({
  node,
  agents,
  toolCatalog,
  update,
  onRefreshAgents,
  registerTokenTarget,
}: {
  node: FlowNode
  agents: Agent[]
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  registerTokenTarget: RegisterTokenTarget
}) {
  switch (node.type) {
    case 'trigger':
      return <TriggerBody node={node} update={update} />
    case 'agent':
      return <AgentBody node={node} agents={agents} update={update} onRefreshAgents={onRefreshAgents} registerTokenTarget={registerTokenTarget} />
    case 'http':
      return <HttpBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'tool':
      return <ToolBody node={node} toolCatalog={toolCatalog} update={update} />
    case 'condition':
      return <ConditionBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'filter':
      return <ConditionBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'transform':
      return <TransformBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'loop':
      return <LoopBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'parallel':
      return <p className="text-sm text-slate-600">Runs {node.data.branches.length || 0} branches side by side. Add and configure branch steps from the settings panel.</p>
    case 'switch':
      return <SwitchBody node={node} update={update} registerTokenTarget={registerTokenTarget} />
    case 'stop':
      return <StopBody node={node} update={update} />
  }
}

function TriggerBody({ node, update }: { node: Extract<FlowNode, { type: 'trigger' }>; update: (node: FlowNode) => void }) {
  const [choosingInput, setChoosingInput] = useState(false)
  const trigger = triggerData(node)
  const fields = triggerInputFieldsFromTrigger(trigger)
  const setTrigger = (next: TriggerData) => update({ ...node, data: { ...node.data, trigger: next } })
  const addField = (kind: InputKind) => {
    const option = INPUT_TYPES.find((type) => type.id === kind) ?? INPUT_TYPES[0]
    setTrigger({
      ...trigger,
      type: 'manual',
      inputFields: [
        ...fields,
        {
          name: uniqueFieldName(option.name, fields),
          type: option.fieldType,
          description: option.description,
        },
      ],
    })
    setChoosingInput(false)
  }
  const updateField = (index: number, patch: Partial<TriggerInputField>) => {
    setTrigger({
      ...trigger,
      type: 'manual',
      inputFields: fields.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)),
    })
  }
  const removeField = (index: number) => {
    setTrigger({ ...trigger, type: 'manual', inputFields: fields.filter((_, fieldIndex) => fieldIndex !== index) })
  }

  return (
    <div className="space-y-4">
      {fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field, fieldIndex) => {
            const inputType = inputTypeForField(field)
            const InputIcon = inputType.icon
            return (
              <div key={`${field.name}-${fieldIndex}`} className="grid gap-3 border-b border-slate-200 pb-3 sm:grid-cols-[42px_minmax(120px,0.7fr)_minmax(150px,1fr)_auto_36px]">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-full', inputType.tone)}>
                  <InputIcon className="h-5 w-5" />
                </span>
                <input
                  value={field.name}
                  onChange={(event) => updateField(fieldIndex, { name: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.label}
                  aria-label="Input name"
                />
                <input
                  value={field.description ?? ''}
                  onChange={(event) => updateField(fieldIndex, { description: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.description}
                  aria-label="Prompt shown for input"
                />
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600" title="The run must supply this value">
                  <input
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(fieldIndex, { required: event.target.checked || undefined })}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeField(fieldIndex)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove input"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {choosingInput ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="mb-3 text-sm font-semibold text-slate-900">Choose the type of user input</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {INPUT_TYPES.map((type) => {
              const InputIcon = type.icon
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => addField(type.id)}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', type.tone)}>
                    <InputIcon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{type.label}</span>
                    <span className="block text-xs text-slate-500">{type.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChoosingInput(true)}
          className="flex w-full items-center gap-3 rounded-lg py-2 text-left text-base font-semibold text-slate-700 hover:text-blue-700"
        >
          <Plus className="h-5 w-5" /> Add an input
        </button>
      )}
    </div>
  )
}

function AgentBody({
  node,
  agents,
  update,
  onRefreshAgents,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'agent' }>
  agents: Agent[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  registerTokenTarget: RegisterTokenTarget
}) {
  const isDefaultInput = defaultAgentInput(node.data.input)
  const responseFormat = node.data.responseFormat ?? 'text'
  const outputFields = node.data.outputFields ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Agent <span className="text-red-500">*</span></label>
        <div className="flex items-center gap-2">
          <select
            value={node.data.agentId}
            onChange={(event) => update({ ...node, data: { ...node.data, agentId: event.target.value } })}
            className={cn(controlClass, 'min-w-0 flex-1')}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          {onRefreshAgents && (
            <button
              type="button"
              onClick={onRefreshAgents}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Refresh agent list"
              title="Refresh agent list"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <a
            href="/dashboard"
            target="_blank"
            rel="noreferrer"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            title="Create a new agent on the dashboard"
          >
            <Plus className="h-4 w-4" /> New
          </a>
        </div>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Message to agent</label>
        <textarea
          value={isDefaultInput ? '' : node.data.input ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, input: event.target.value } })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'agent' ? (defaultAgentInput(n.data.input) ? '' : n.data.input ?? '') : ''),
            (n, v) => (n.type === 'agent' ? { ...n, data: { ...n.data, input: v } } : n),
          )}
          className={textareaClass}
          placeholder={isDefaultInput ? 'Uses the trigger input by default. Add instructions here if needed.' : 'Tell the agent what to do at this step.'}
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Request human assistance when unsure</p>
          <p className="mt-0.5 text-xs text-slate-500">When the agent isn&apos;t sure how to proceed, the flow pauses and asks for input.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.data.humanAssistance !== false}
          onClick={() => update({ ...node, data: { ...node.data, humanAssistance: node.data.humanAssistance === false ? undefined : false } })}
          className={cn(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
            node.data.humanAssistance !== false ? 'bg-blue-600' : 'bg-slate-300',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              node.data.humanAssistance !== false ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Agent response</label>
          <select
            value={responseFormat}
            onChange={(event) =>
              update({ ...node, data: { ...node.data, responseFormat: event.target.value === 'structured' ? 'structured' : undefined } })
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 outline-none"
          >
            <option value="text">Text only</option>
            <option value="structured">Structured</option>
          </select>
        </div>
        <p className="text-xs text-slate-500">
          {responseFormat === 'structured'
            ? 'The agent must reply with JSON matching these properties; each becomes data for later steps.'
            : 'The agent replies with plain text. Switch to Structured to map fields into later steps.'}
        </p>
        {responseFormat === 'structured' && (
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  className={controlClass}
                  placeholder="propertyName"
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove property"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add property
            </button>
          </div>
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function HttpBody({
  node,
  update,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'http' }>
  update: (node: FlowNode) => void
  registerTokenTarget: RegisterTokenTarget
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
        <div className="grid gap-2">
          <label className={labelClass}>URI <span className="text-red-500">*</span></label>
          <input
            value={node.data.url}
            onChange={(event) => update({ ...node, data: { ...node.data, url: event.target.value } })}
            onFocus={registerTokenTarget(
              (n) => (n.type === 'http' ? n.data.url : ''),
              (n, v) => (n.type === 'http' ? { ...n, data: { ...n.data, url: v } } : n),
            )}
            className={controlClass}
            placeholder="https://api.example.com/endpoint"
          />
        </div>
        <div className="grid gap-2">
          <label className={labelClass}>Method <span className="text-red-500">*</span></label>
          <select
            value={node.data.method}
            onChange={(event) => update({ ...node, data: { ...node.data, method: event.target.value as typeof node.data.method } })}
            className={controlClass}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
      </div>
      <InlineKeyValue
        label="Headers"
        value={node.data.headers}
        onChange={(headers) => update({ ...node, data: { ...node.data, headers } })}
        registerValueFocus={(index) =>
          registerTokenTarget(
            (n) => (n.type === 'http' ? parseKeyValueRows(n.data.headers)[index]?.value ?? '' : ''),
            (n, v) => {
              if (n.type !== 'http') return n
              const rows = parseKeyValueRows(n.data.headers)
              rows[index] = { key: rows[index]?.key ?? '', value: v }
              return { ...n, data: { ...n.data, headers: serializeKeyValueRows(rows) } }
            },
          )
        }
      />
      <InlineKeyValue
        label="Queries"
        value={node.data.query}
        onChange={(query) => update({ ...node, data: { ...node.data, query } })}
        registerValueFocus={(index) =>
          registerTokenTarget(
            (n) => (n.type === 'http' ? parseKeyValueRows(n.data.query)[index]?.value ?? '' : ''),
            (n, v) => {
              if (n.type !== 'http') return n
              const rows = parseKeyValueRows(n.data.query)
              rows[index] = { key: rows[index]?.key ?? '', value: v }
              return { ...n, data: { ...n.data, query: serializeKeyValueRows(rows) } }
            },
          )
        }
      />
      <div className="grid gap-2">
        <label className={labelClass}>Body</label>
        <textarea
          value={node.data.body ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, body: event.target.value } })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'http' ? n.data.body ?? '' : ''),
            (n, v) => (n.type === 'http' ? { ...n, data: { ...n.data, body: v } } : n),
          )}
          className={textareaClass}
          placeholder="Optional JSON or text body for POST, PUT, and PATCH requests."
        />
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function InlineKeyValue({
  label,
  value,
  onChange,
  registerValueFocus,
}: {
  label: string
  value?: string
  onChange: (value: string) => void
  registerValueFocus: (index: number) => (event: React.FocusEvent<HTMLInputElement>) => void
}) {
  const rows = parseKeyValueRows(value)
  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(serializeKeyValueRows(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))))
  }
  const addRow = () => onChange(serializeKeyValueRows([...rows, { key: '', value: '' }]))
  const removeRow = (index: number) => onChange(serializeKeyValueRows(rows.filter((_, rowIndex) => rowIndex !== index)))

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <label className={labelClass}>{label}</label>
        <button type="button" onClick={addRow} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
          Add row
        </button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={`${label}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
            <input
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
              className={controlClass}
              placeholder="Key"
            />
            <input
              value={row.value}
              onChange={(event) => updateRow(index, { value: event.target.value })}
              onFocus={registerValueFocus(index)}
              className={controlClass}
              placeholder="Value"
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${label.toLowerCase()} row`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolBody({ node, toolCatalog, update }: { node: Extract<FlowNode, { type: 'tool' }>; toolCatalog: ToolCatalog; update: (node: FlowNode) => void }) {
  const { connection, tool } = selectedTool(node.data.connectionId, node.data.toolName, toolCatalog)
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Connection <span className="text-red-500">*</span></label>
        <select
          value={node.data.connectionId}
          onChange={(event) => {
            const nextConnection = toolCatalog.find((entry) => entry.id === event.target.value)
            update({ ...node, data: { ...node.data, connectionId: event.target.value, toolName: nextConnection?.tools[0]?.name ?? '' } })
          }}
          className={controlClass}
        >
          <option value="">Choose a connected tool</option>
          {toolCatalog.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>
      {connection && (
        <div className="grid gap-2">
          <label className={labelClass}>Action <span className="text-red-500">*</span></label>
          <select
            value={node.data.toolName}
            onChange={(event) => update({ ...node, data: { ...node.data, toolName: event.target.value } })}
            className={controlClass}
          >
            <option value="">Choose an action</option>
            {connection.tools.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {connection ? (
        <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          <IntegrationLogo slug={connection.id} name={connection.name} className="h-8 w-8 rounded-lg bg-white p-1" />
          <p>
            {tool ? tool.description || 'Configure action inputs in the settings panel.' : 'Choose the action this connection should run.'}
          </p>
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Connectors available on this workspace will show here.</p>
      )}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function ConditionBody({
  node,
  update,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'condition' | 'filter' }>
  update: (node: FlowNode) => void
  registerTokenTarget: RegisterTokenTarget
}) {
  const clause = firstClause(node)
  const setClause = (patch: Partial<ConditionClause>) => {
    update({ ...node, data: { ...node.data, clauses: [{ ...clause, ...patch }], match: node.data.match ?? 'all' } } as FlowNode)
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{node.type === 'condition' ? 'Route the flow based on a rule.' : 'Continue only when this rule is true.'}</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
        <input
          value={clause.left}
          onChange={(event) => setClause({ left: event.target.value })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'condition' || n.type === 'filter' ? firstClause(n).left : ''),
            (n, v) =>
              n.type === 'condition' || n.type === 'filter'
                ? ({ ...n, data: { ...n.data, clauses: [{ ...firstClause(n), left: v }], match: n.data.match ?? 'all' } } as FlowNode)
                : n,
          )}
          className={controlClass}
          placeholder="Field or value"
        />
        <select value={clause.op} onChange={(event) => setClause({ op: event.target.value as ConditionOp })} className={controlClass}>
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <input
          value={clause.right}
          onChange={(event) => setClause({ right: event.target.value })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'condition' || n.type === 'filter' ? firstClause(n).right : ''),
            (n, v) =>
              n.type === 'condition' || n.type === 'filter'
                ? ({ ...n, data: { ...n.data, clauses: [{ ...firstClause(n), right: v }], match: n.data.match ?? 'all' } } as FlowNode)
                : n,
          )}
          className={controlClass}
          placeholder="Compare to"
        />
      </div>
    </div>
  )
}

function TransformBody({
  node,
  update,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'transform' }>
  update: (node: FlowNode) => void
  registerTokenTarget: RegisterTokenTarget
}) {
  const fields = transformFields(node)
  const setFields = (next: typeof fields) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Create a clean object for later steps.</p>
      {fields.map((field, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
          <input
            value={field.name}
            onChange={(event) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, name: event.target.value } : entry)))}
            className={controlClass}
            placeholder="Output field"
          />
          <input
            value={field.value}
            onChange={(event) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, value: event.target.value } : entry)))}
            onFocus={registerTokenTarget(
              (n) => (n.type === 'transform' ? transformFields(n)[index]?.value ?? '' : ''),
              (n, v) =>
                n.type === 'transform'
                  ? { ...n, data: { ...n.data, fields: transformFields(n).map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, value: v } : entry)) } }
                  : n,
            )}
            className={controlClass}
            placeholder="Value"
          />
          <button
            type="button"
            onClick={() => setFields(fields.filter((_, fieldIndex) => fieldIndex !== index))}
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove field"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setFields([...fields, { name: '', value: '' }])} className="text-sm font-semibold text-blue-700 hover:text-blue-900">
        Add field
      </button>
    </div>
  )
}

function LoopBody({
  node,
  update,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'loop' }>
  update: (node: FlowNode) => void
  registerTokenTarget: RegisterTokenTarget
}) {
  const usesTriggerInput = node.data.over === '{{trigger.input}}'
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Run the steps inside this loop once for each item in a list.</p>
      <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
        <select
          value={usesTriggerInput ? 'trigger' : 'custom'}
          onChange={(event) => update({ ...node, data: { ...node.data, over: event.target.value === 'trigger' ? '{{trigger.input}}' : '' } })}
          className={controlClass}
        >
          <option value="trigger">Trigger input</option>
          <option value="custom">Custom list</option>
        </select>
        <input
          value={usesTriggerInput ? '' : node.data.over}
          onChange={(event) => update({ ...node, data: { ...node.data, over: event.target.value } })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'loop' ? (n.data.over === '{{trigger.input}}' ? '' : n.data.over) : ''),
            (n, v) => (n.type === 'loop' ? { ...n, data: { ...n.data, over: v } } : n),
          )}
          className={controlClass}
          placeholder={usesTriggerInput ? 'Uses trigger input' : 'Comma-separated list, JSON array, or mapped list'}
          disabled={usesTriggerInput}
        />
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function SwitchBody({
  node,
  update,
  registerTokenTarget,
}: {
  node: Extract<FlowNode, { type: 'switch' }>
  update: (node: FlowNode) => void
  registerTokenTarget: RegisterTokenTarget
}) {
  const first = switchFirstCase(node)
  const setFirst = (patch: Partial<typeof first>) => update({ ...node, data: { ...node.data, cases: [{ ...first, ...patch }] } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Route to the first matching case, otherwise use the default path.</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
        <input
          value={first.left}
          onChange={(event) => setFirst({ left: event.target.value })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'switch' ? switchFirstCase(n).left : ''),
            (n, v) => (n.type === 'switch' ? { ...n, data: { ...n.data, cases: [{ ...switchFirstCase(n), left: v }] } } : n),
          )}
          className={controlClass}
          placeholder="Field or value"
        />
        <select value={first.op} onChange={(event) => setFirst({ op: event.target.value as ConditionOp })} className={controlClass}>
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <input
          value={first.right}
          onChange={(event) => setFirst({ right: event.target.value })}
          onFocus={registerTokenTarget(
            (n) => (n.type === 'switch' ? switchFirstCase(n).right : ''),
            (n, v) => (n.type === 'switch' ? { ...n, data: { ...n.data, cases: [{ ...switchFirstCase(n), right: v }] } } : n),
          )}
          className={controlClass}
          placeholder="Compare to"
        />
      </div>
    </div>
  )
}

function StopBody({ node, update }: { node: Extract<FlowNode, { type: 'stop' }>; update: (node: FlowNode) => void }) {
  return (
    <div className="grid gap-2">
      <label className={labelClass}>Message</label>
      <input
        value={node.data.reason ?? ''}
        onChange={(event) => update({ ...node, data: { ...node.data, reason: event.target.value } })}
        className={controlClass}
        placeholder="Optional reason shown when this flow stops"
      />
    </div>
  )
}
