import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog, type FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'
import { outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'

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

const graphRules =
  'You design runnable workflow graphs for Backstory Studio. Return a single JSON object with one property, graphJson: a JSON string containing the flow graph, shaped as {"nodes": [...], "edges": [...]}. ' +
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
  'Edges connect node ids; condition edges use branch "true"/"false"; switch edges use case ids or "default". ' +
  'When a later step references {{step.<agentNodeId>.output.<field>}}, that agent node MUST set responseFormat: "structured" and declare outputFields: [{name,type}] matching the referenced fields.'

export async function buildCopilotGrounding(
  organizationId: string,
  userId: string,
): Promise<{
  roster: { id: string; name: string }[]
  toolCatalog: FlowToolCatalogConnection[]
  contextBlock: string
  graphRules: string
}> {
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentVisibilityScope(userId) },
      select: { id: true, description: true, metadata: true },
      take: 100,
    }),
    loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 100 }),
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
  const contextBlock = [
    `Agents:\n${roster.map((entry) => `- ${entry.name} (id: ${entry.id})`).join('\n') || '- None available'}`,
    '',
    `Tools:\n${tools.map((tool) => `- ${tool.connectionName}: ${tool.name} (connectionId: ${tool.connectionId})${tool.inputHint ? ` args: ${tool.inputHint}` : ''}${tool.outputHint ? ` outputs: ${tool.outputHint}` : ''}${tool.description ? ` — ${tool.description}` : ''}`).join('\n') || '- None available'}`,
  ].join('\n')
  return { roster, toolCatalog, contextBlock, graphRules }
}
