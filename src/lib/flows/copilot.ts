import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { FlowValidationResult } from '@/lib/flows/validate'

export type FlowCopilotToolCatalog = {
  id: string
  tools: { name: string }[]
}[]

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

export function repairGeneratedFlowGraph(
  candidate: FlowGraph,
  context: { agents: { id: string }[]; toolCatalog: FlowCopilotToolCatalog },
): FlowGraph {
  const agentIds = new Set(context.agents.map((agent) => agent.id))
  const connectionIds = new Set(context.toolCatalog.map((connection) => connection.id))
  const toolNames = new Map(context.toolCatalog.map((connection) => [connection.id, new Set(connection.tools.map((tool) => tool.name))]))
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

  const sanitizedNodes = sanitizeContainers(nodes)
  if (!sanitizedNodes.some((node) => node.type === 'trigger')) sanitizedNodes.unshift({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } })
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
