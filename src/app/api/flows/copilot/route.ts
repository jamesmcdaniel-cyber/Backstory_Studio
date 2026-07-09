import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, validationIssuesForModel } from '@/lib/flows/copilot'
import { validateFlowGraph } from '@/lib/flows/validate'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'

// JSON-schema the model must fill: a graph of nodes + edges. Kept loose here
// (objects) and tightened by flowGraphSchema.parse afterwards.
const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    nodes: { type: 'array', items: { type: 'object' } },
    edges: { type: 'array', items: { type: 'object' } },
  },
  required: ['nodes', 'edges'],
  additionalProperties: false,
}

function toolInputHint(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const shape = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
  const props = Object.entries(shape.properties ?? {}).slice(0, 8)
  if (!props.length) return ''
  const required = new Set(shape.required ?? [])
  return props.map(([name, prop]) => `${name}${required.has(name) ? '*' : ''}:${prop.type ?? 'any'}`).join(', ')
}

function toolOutputHint(schema: unknown): string {
  const fields = outputFieldsFromJsonSchema(schema, 8)
  return fields.map((field) => `${field.name}:${field.type}`).join(', ')
}

const requestSchema = z.object({
  description: z.string().min(1),
  currentGraph: z.unknown().optional(),
  issues: z.array(z.string()).max(50).optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description, currentGraph, issues } = requestSchema.parse(await request.json())
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: auth.organizationId, status: 'ACTIVE', ...agentVisibilityScope(auth.dbUser.id) },
      select: { id: true, description: true, metadata: true },
      take: 100,
    }),
    loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id, takeConnections: 25, takeTools: 100 }),
  ])
  const roster = agents
    .map((agent) => ({ id: agent.id, name: readAgentMetadata(agent.metadata).title || agent.description }))
    .filter((entry) => entry.name)
  const tools = toolCatalog.flatMap((connection) =>
    connection.tools.map((tool) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      name: tool.name,
      description: tool.description,
      inputHint: toolInputHint(tool.inputSchema),
      outputHint: toolOutputHint(tool.outputSchema),
    })),
  )

  const system =
    'You design runnable workflow graphs for Backstory Studio. Return ONLY JSON matching the graph schema. ' +
    'Always include one trigger node with id "trigger". Prefer deterministic tool nodes for concrete integration actions and agent nodes for reasoning/writing decisions. ' +
    'Allowed node types: agent, tool, http, transform, filter, condition, switch, loop, parallel, stop. ' +
    'If the flow expects named input fields, put them on the trigger as data.trigger.inputFields: [{name,type,description}]. ' +
    'Agent data: {agentId, label, input}; agentId MUST be from the agent roster. ' +
    'Tool data: {connectionId, toolName, label, args, retries, timeoutMs}; connectionId/toolName MUST be from available tools and args MUST be a JSON object string. Use retries for flaky external actions and timeoutMs for slow tools. ' +
    'For required tool args that should come from the run form, declare trigger inputFields and map args to {{trigger.input.fieldName}}. ' +
    'HTTP data: {method,url,query,headers,bodyMode,responseType,failOnHttpError,retries,timeoutMs,body}; method is GET/POST/PUT/PATCH/DELETE, query/headers/body are JSON strings, bodyMode is json/text/none, responseType is auto/json/text. ' +
    'HTTP output is an object with ok, status, statusText, url, headers, body, and bodyText; use {{step.<httpNodeId>.output.body}} for parsed API response data and {{step.<httpNodeId>.output.status}} for status checks. ' +
    'Use data references only when needed: {{trigger.input}}, {{step.<nodeId>.output}}, {{step.<nodeId>.output.field}}, {{item}}, {{item.field}}, {{loop.index}}. ' +
    'For loops, data.over should point at a list and data.body should contain nested node ids. For condition/filter, use data.clauses with left/op/right. ' +
    'Edges connect node ids; condition edges use branch "true"/"false"; switch edges use case ids or "default".'
  const contextBlock = [
    `Agents:\n${roster.map((entry) => `- ${entry.name} (id: ${entry.id})`).join('\n') || '- None available'}`,
    '',
    `Tools:\n${tools.map((tool) => `- ${tool.connectionName}: ${tool.name} (connectionId: ${tool.connectionId})${tool.inputHint ? ` args: ${tool.inputHint}` : ''}${tool.outputHint ? ` outputs: ${tool.outputHint}` : ''}${tool.description ? ` — ${tool.description}` : ''}`).join('\n') || '- None available'}`,
  ].join('\n')

  // REPAIR MODE: an existing graph plus checker issues to fix in place, rather
  // than describing a brand-new flow. Falls back to generate mode when the
  // graph is missing/invalid or no issues were supplied.
  const parsedCurrentGraph = currentGraph !== undefined ? flowGraphSchema.safeParse(currentGraph) : undefined
  const isRepairMode = Boolean(parsedCurrentGraph?.success && issues?.length)

  const user = isRepairMode
    ? [
        `Current flow graph JSON:\n${JSON.stringify(parsedCurrentGraph!.data)}`,
        '',
        `This existing flow has these validation problems:\n${issues!.map((issue) => `- ${issue}`).join('\n')}`,
        'Return the SAME flow with the minimal changes needed to fix every problem. Keep node ids, structure, and configured values wherever possible; do not redesign the flow.',
        '',
        contextBlock,
      ].join('\n')
    : [`Build a flow that: ${description}`, '', contextBlock].join('\n')

  try {
    const validationContext = {
      agents: roster.map((agent) => ({ id: agent.id, title: agent.name })),
      toolCatalog,
    }
    const raw = await generateStructured({ system, user, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph', maxTokens: 3500 })
    let graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(JSON.parse(raw))), { agents: roster, toolCatalog })
    let validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })

    if (!validation.ok) {
      const repairUser = [
        user,
        '',
        'The graph below did not pass validation. Return a corrected full graph object that fixes every error while preserving the user request.',
        '',
        `Validation errors:\n${validationIssuesForModel(validation)}`,
        '',
        `Broken graph:\n${JSON.stringify(graph)}`,
      ].join('\n')
      const repairedRaw = await generateStructured({ system, user: repairUser, schema: GRAPH_JSON_SCHEMA, schemaName: 'flow_graph_repair', maxTokens: 3500 })
      graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(JSON.parse(repairedRaw))), { agents: roster, toolCatalog })
      validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })
    }

    return { success: true, graph, validation }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not generate a runnable flow.',
      graph: emptyGraph(),
    }
  }
})
