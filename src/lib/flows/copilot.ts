import type { FlowGraph, FlowNode, FieldType, OutputField } from '@/lib/flows/graph'
import { outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import type { FlowValidationResult } from '@/lib/flows/validate'

export type FlowCopilotToolCatalog = {
  id: string
  tools: { name: string; inputSchema?: unknown; outputSchema?: unknown }[]
}[]

type RequiredToolArg = {
  name: string
  type: FieldType
  description?: string
}

const FIELD_TYPE_ALIASES: Record<string, FieldType> = {
  string: 'string',
  text: 'string',
  number: 'number',
  integer: 'number',
  float: 'number',
  boolean: 'boolean',
  bool: 'boolean',
  object: 'object',
  json: 'object',
  array: 'array',
  list: 'array',
  any: 'any',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeFieldType(value: unknown): FieldType {
  return typeof value === 'string' ? FIELD_TYPE_ALIASES[value.toLowerCase()] ?? 'any' : 'any'
}

function stringifyConfigValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeOutputFields(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((field) => (isRecord(field) ? { ...field, type: normalizeFieldType(field.type) } : field))
}

function normalizeTriggerConfig(value: unknown): unknown {
  if (!isRecord(value)) return value
  return { ...value, inputFields: normalizeOutputFields(value.inputFields) }
}

function normalizeNodeData(type: unknown, data: Record<string, unknown>): Record<string, unknown> {
  const retries = numericValue(data.retries)
  const timeoutSeconds = numericValue(data.timeoutSeconds)
  const timeoutMs = numericValue(data.timeoutMs) ?? (timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined)
  const normalized = {
    ...data,
    ...(data.outputFields !== undefined ? { outputFields: normalizeOutputFields(data.outputFields) } : {}),
    ...(retries !== undefined ? { retries: Math.round(retries) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: Math.round(timeoutMs) } : {}),
  }
  if (type === 'trigger') return { ...normalized, trigger: normalizeTriggerConfig(data.trigger) }
  if (type === 'tool') return { ...normalized, args: stringifyConfigValue(data.args) }
  if (type === 'http') {
    return {
      ...normalized,
      method: typeof data.method === 'string' ? data.method.toUpperCase() : data.method,
      query: stringifyConfigValue(data.query),
      headers: stringifyConfigValue(data.headers),
      body: stringifyConfigValue(data.body),
    }
  }
  return normalized
}

export function normalizeGeneratedFlowGraphInput(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.nodes)) return candidate
  return {
    ...candidate,
    nodes: candidate.nodes.map((node) => {
      if (!isRecord(node) || !isRecord(node.data)) return node
      return { ...node, data: normalizeNodeData(node.type, node.data) }
    }),
    edges: Array.isArray(candidate.edges)
      ? candidate.edges.map((edge) => (isRecord(edge) && edge.branch !== undefined ? { ...edge, branch: String(edge.branch) } : edge))
      : candidate.edges,
  }
}

function edgeId(source: string, target: string, branch?: string) {
  return `${source}->${target}${branch ? `:${branch}` : ''}`
}

function sanitizeContainers(nodes: FlowNode[]): FlowNode[] {
  const keep = new Set(nodes.map((node) => node.id))
  return nodes.map((node) => {
    if (node.type === 'loop') return { ...node, data: { ...node.data, body: node.data.body.filter((id) => keep.has(id)) } }
    if (node.type === 'parallel') {
      return {
        ...node,
        data: {
          ...node.data,
          branches: node.data.branches.map((branch) => branch.filter((id) => keep.has(id))).filter((branch) => branch.length > 0),
        },
      }
    }
    return node
  })
}

function schemaFieldType(value: unknown): FieldType {
  if (!isRecord(value)) return 'any'
  const type = Array.isArray(value.type) ? value.type[0] : value.type
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'object' || type === 'array' ? type : 'any'
}

function requiredToolArgs(inputSchema: unknown): RequiredToolArg[] {
  if (!isRecord(inputSchema)) return []
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return []
  const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === 'string') : []
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {}
  return required.map((name) => {
    const prop = properties[name]
    return {
      name,
      type: schemaFieldType(prop),
      ...(isRecord(prop) && typeof prop.description === 'string' ? { description: prop.description } : {}),
    }
  })
}

function parseArgsObject(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function argHasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

function inputNameForArg(argName: string, existing: Set<string>, used: Set<string>): { name: string; isNew: boolean } {
  const base = argName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'input'
  if (existing.has(base)) {
    used.add(base)
    return { name: base, isNew: false }
  }
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return { name: candidate, isNew: true }
}

function existingInputFieldNames(trigger: Extract<FlowNode, { type: 'trigger' }> | undefined): Set<string> {
  const config = trigger?.data.trigger
  const fields = isRecord(config) && Array.isArray(config.inputFields) ? config.inputFields : []
  return new Set(fields.filter(isRecord).map((field) => (typeof field.name === 'string' ? field.name.trim() : '')).filter(Boolean))
}

function appendTriggerInputFields(nodes: FlowNode[], fields: OutputField[]): FlowNode[] {
  if (!fields.length) return nodes
  return nodes.map((node) => {
    if (node.type !== 'trigger') return node
    const trigger = isRecord(node.data.trigger) ? node.data.trigger : { type: 'manual' }
    const existing = Array.isArray(trigger.inputFields) ? trigger.inputFields.filter(isRecord) : []
    const existingNames = new Set(existing.map((field) => (typeof field.name === 'string' ? field.name.trim() : '')).filter(Boolean))
    const additions = fields.filter((field) => !existingNames.has(field.name))
    if (!additions.length) return node
    return {
      ...node,
      data: {
        ...node.data,
        trigger: {
          ...trigger,
          inputFields: [...existing, ...additions],
        },
      },
    }
  })
}

export function repairGeneratedFlowGraph(
  candidate: FlowGraph,
  context: { agents: { id: string }[]; toolCatalog: FlowCopilotToolCatalog },
): FlowGraph {
  const agentIds = new Set(context.agents.map((agent) => agent.id))
  const connectionIds = new Set(context.toolCatalog.map((connection) => connection.id))
  const toolNames = new Map(context.toolCatalog.map((connection) => [connection.id, new Set(connection.tools.map((tool) => tool.name))]))
  const toolsByConnection = new Map(context.toolCatalog.map((connection) => [
    connection.id,
    new Map(connection.tools.map((tool) => [tool.name, tool])),
  ]))
  const seen = new Set<string>()
  const nodes: FlowNode[] = []

  for (const node of candidate.nodes) {
    if (seen.has(node.id)) continue
    if (node.type === 'trigger') {
      if (!seen.has('trigger')) {
        nodes.push({ id: 'trigger', type: 'trigger', data: node.data })
        seen.add('trigger')
      }
      continue
    }
    if (node.type === 'agent' && !agentIds.has(node.data.agentId)) continue
    if (node.type === 'tool') {
      const knownTools = toolNames.get(node.data.connectionId)
      if (!connectionIds.has(node.data.connectionId) || (knownTools?.size && !knownTools.has(node.data.toolName))) continue
    }
    nodes.push(node)
    seen.add(node.id)
  }

  let sanitizedNodes = sanitizeContainers(nodes)
  if (!sanitizedNodes.some((node) => node.type === 'trigger')) sanitizedNodes.unshift({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } })
  const trigger = sanitizedNodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  const existingInputNames = existingInputFieldNames(trigger)
  const usedInputNames = new Set(existingInputNames)
  const inferredInputFields: OutputField[] = []
  sanitizedNodes = sanitizedNodes.map((node) => {
    if (node.type !== 'tool') return node
    const tool = toolsByConnection.get(node.data.connectionId)?.get(node.data.toolName)
    const requiredArgs = requiredToolArgs(tool?.inputSchema)
    const outputFields = node.data.outputFields?.length ? node.data.outputFields : outputFieldsFromJsonSchema(tool?.outputSchema)
    const args = parseArgsObject(node.data.args)
    let changed = !node.data.args?.trim()
    if (requiredArgs.length) {
      for (const required of requiredArgs) {
        if (argHasValue(args[required.name])) continue
        const { name: inputName, isNew } = inputNameForArg(required.name, existingInputNames, usedInputNames)
        args[required.name] = `{{trigger.input.${inputName}}}`
        if (isNew) {
          inferredInputFields.push({
            name: inputName,
            type: required.type,
            description: required.description || `Required by ${node.data.toolName}.`,
          })
        }
        changed = true
      }
    }
    const data = {
      ...node.data,
      ...(changed ? { args: JSON.stringify(args, null, 2) } : {}),
      ...(outputFields.length ? { outputFields } : {}),
    }
    return changed || outputFields.length ? { ...node, data } : node
  })
  sanitizedNodes = appendTriggerInputFields(sanitizedNodes, inferredInputFields)
  const keep = new Set(sanitizedNodes.map((node) => node.id))
  const edges = candidate.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target))
  const actionable = sanitizedNodes.find((node) => node.type !== 'trigger')
  if (actionable && !edges.some((edge) => edge.source === 'trigger')) {
    edges.push({ id: edgeId('trigger', actionable.id), source: 'trigger', target: actionable.id })
  }
  return { nodes: sanitizedNodes, edges }
}

export function validationIssuesForModel(validation: FlowValidationResult): string {
  return validation.errors
    .slice(0, 10)
    .map((issue) => `- ${issue.code}${issue.nodeId ? ` at ${issue.nodeId}` : ''}: ${issue.message}`)
    .join('\n')
}
