import type { StepType } from '@/lib/flows/mutate'

/** One pickable item in the Add-trigger/Add-action catalog. */
export type PickerLeaf = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  stepType?: StepType
  seed?: { agentId?: string; connectionId?: string; toolName?: string; label?: string }
  triggerType?: 'manual' | 'schedule' | 'webhook' | 'signal'
}

export type PickerGroup = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  children: PickerLeaf[]
}

/** Built-in tool groups with MS-style drill-in. */
export const BUILTIN_GROUPS: PickerGroup[] = [
  {
    id: 'http',
    label: 'HTTP',
    description: 'Call APIs and webhooks with full request control.',
    mode: 'action',
    children: [
      { id: 'http-request', label: 'HTTP', description: 'Send a request to any API endpoint and use the response.', mode: 'action', stepType: 'http' },
      { id: 'http-webhook-out', label: 'HTTP Webhook', description: 'Post a payload to an external webhook URL.', mode: 'action', stepType: 'http', seed: { label: 'Webhook' } },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    description: 'Branch, loop, and stop the flow.',
    mode: 'action',
    children: [
      { id: 'control-condition', label: 'Condition', description: 'Route down different paths based on a rule.', mode: 'action', stepType: 'condition' },
      { id: 'control-switch', label: 'Switch', description: 'Route to one of several cases, with a default path.', mode: 'action', stepType: 'switch' },
      { id: 'control-loop', label: 'For each', description: 'Run steps once for every item in a list.', mode: 'action', stepType: 'loop' },
      { id: 'control-parallel', label: 'Parallel branches', description: 'Run independent branches at the same time.', mode: 'action', stepType: 'parallel' },
      { id: 'control-stop', label: 'Stop flow', description: 'End the flow early with an optional message.', mode: 'action', stepType: 'stop' },
    ],
  },
  {
    id: 'data-operation',
    label: 'Data Operation',
    description: 'Shape and filter data between steps.',
    mode: 'action',
    children: [
      { id: 'data-compose', label: 'Set fields', description: 'Create named values later steps can reuse.', mode: 'action', stepType: 'transform' },
      { id: 'data-filter', label: 'Filter', description: 'Continue only when a value matches a rule.', mode: 'action', stepType: 'filter' },
    ],
  },
  {
    id: 'variable',
    label: 'Variable',
    description: 'Store a value for later steps.',
    mode: 'action',
    children: [
      { id: 'variable-set', label: 'Set variable', description: 'Save a named value for downstream steps.', mode: 'action', stepType: 'transform', seed: { label: 'Set variable' } },
    ],
  },
]

/** AI capabilities shown first in action mode. */
export const AI_CAPABILITY_LEAVES: PickerLeaf[] = [
  { id: 'ai-run-agent', label: 'Run an agent', description: 'Run one of your agents and pass its response to the next step.', mode: 'action', stepType: 'agent' },
  { id: 'ai-run-prompt', label: 'Run a prompt', description: 'One-off AI step: give instructions, get a response — no saved agent needed.', mode: 'action', stepType: 'agent', seed: { label: 'Run a prompt' } },
]

/** Trigger-mode top level: the four ways a flow can start. */
export const TRIGGER_LEAVES: PickerLeaf[] = [
  { id: 'trigger-manual', label: 'Manually trigger a flow', description: 'Start it from the builder or with typed inputs.', mode: 'trigger', triggerType: 'manual' },
  { id: 'trigger-schedule', label: 'Schedule', description: 'Run on a recurrence you define.', mode: 'trigger', triggerType: 'schedule' },
  { id: 'trigger-webhook', label: 'When an HTTP request is received', description: 'Start when an external system posts to a secret URL.', mode: 'trigger', triggerType: 'webhook' },
  { id: 'trigger-signal', label: 'When a signal fires', description: 'Start from an in-platform event, like another flow completing.', mode: 'trigger', triggerType: 'signal' },
]

export function searchCorpus(leaf: PickerLeaf): string {
  return `${leaf.label} ${leaf.description}`.toLowerCase()
}
