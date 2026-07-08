import type { FlowGraph } from '@/lib/flows/graph'

export const FLOW_TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'signal'] as const
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number]
export type FlowTrigger = { type: FlowTriggerType; [key: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validTriggerType(value: unknown): value is FlowTriggerType {
  return typeof value === 'string' && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value)
}

export function normalizeFlowTrigger(value: unknown, fallback?: unknown): FlowTrigger {
  const input = isRecord(value) ? value : undefined
  const base = input ?? (isRecord(fallback) ? fallback : {})
  const type = validTriggerType(base.type) ? base.type : 'manual'
  return { ...base, type }
}

/**
 * The builder stores the editable trigger on the graph's trigger node. Runtime
 * dispatchers read Flow.trigger, so every save/publish must sync this value.
 */
export function triggerFromGraph(graph: FlowGraph, fallback?: unknown): FlowTrigger {
  const node = graph.nodes.find((candidate) => candidate.type === 'trigger')
  const trigger = node?.type === 'trigger' ? node.data.trigger : undefined
  return normalizeFlowTrigger(trigger, fallback)
}

export function preserveWebhookSecretHash(next: unknown, existing: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(next)
  if (isRecord(existing) && typeof existing.webhookSecretHash === 'string') {
    trigger.webhookSecretHash = existing.webhookSecretHash
  }
  return trigger
}
