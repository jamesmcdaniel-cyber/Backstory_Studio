import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, validationIssuesForModel } from '@/lib/flows/copilot'
import { validateFlowGraph } from '@/lib/flows/validate'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

// Anthropic strict structured outputs can't express a free-form object
// ({type:'object'} with no declared properties collapses to {} under
// additionalProperties:false), and node/edge shapes vary too much per node
// type to enumerate as a strict schema. So the model returns the whole graph
// as a JSON STRING inside a wrapper object, and we JSON.parse that string
// ourselves — see parseGeneratedGraphReply below.
const GRAPH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    graphJson: {
      type: 'string',
      description: 'The complete flow graph as a JSON string: {"nodes": [...], "edges": [...]}',
    },
  },
  required: ['graphJson'],
  additionalProperties: false,
}

/**
 * Tolerantly extract the graph object from a structured-output reply shaped
 * as {graphJson: "..."}. Strips ```json fences from the inner string before
 * parsing. Falls back to treating the raw reply itself as the graph JSON
 * (pre-wrapper shape) for backward safety, in case the model ever emits the
 * graph directly instead of through the string wrapper.
 */
function parseGeneratedGraphReply(raw: string): unknown {
  const outer = JSON.parse(raw)
  const graphJson = isRecord(outer) ? outer.graphJson : undefined
  if (typeof graphJson !== 'string') return outer
  const trimmed = graphJson.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const requestSchema = z.object({
  description: z.string().min(1),
  currentGraph: z.unknown().optional(),
  issues: z.array(z.string()).max(50).optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description, currentGraph, issues } = requestSchema.parse(await request.json())
  // Gate before any model spend: provider configured, caller under rate limit,
  // workspace under its monthly ceiling. Generation makes up to 3 model calls,
  // so a tighter per-minute limit than plain chat.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `flow-copilot:${auth.dbUser.id}`, limit: 10 })
  const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(auth.organizationId, auth.dbUser.id)
  const system = graphRules

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
    // Accumulate model I/O for best-effort metering (generateStructured returns
    // no usage counts); repair rounds append below.
    const rawParts: string[] = [raw]
    let graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(raw))), { agents: roster, toolCatalog })
    let validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })

    for (let round = 0; round < 2 && !validation.ok; round += 1) {
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
      rawParts.push(repairUser, repairedRaw)
      graph = repairGeneratedFlowGraph(flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(repairedRaw))), { agents: roster, toolCatalog })
      validation = validateFlowGraph(graph, { ...validationContext, requireRunnable: graph.nodes.length > 1 })
    }

    recordEstimatedUsage(auth.organizationId, system, user, ...rawParts)
    const needsAttention = [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))
    return { success: true, graph, validation, needsAttention }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not generate a runnable flow.',
      graph: emptyGraph(),
    }
  }
})
