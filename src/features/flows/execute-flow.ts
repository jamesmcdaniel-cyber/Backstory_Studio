import { prisma } from '@/lib/prisma'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError } from '@/lib/server/api-handler'
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { interpretFlow, type RunAgentFn, type RunActionFn } from './interpret'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries } from './action-reliability'
import { prepareHttpRequest, responseOutput } from './http'
import { shouldPersistInterpreterStep } from './run-step-persistence'
import { prepareToolArgs } from './tool-args'
import { flowToolOutput } from './tool-output'

export type FlowExecutionJob = {
  flowId: string
  organizationId: string
  userId: string
  input?: unknown
  flowRunId?: string
  // Resume a paused run: the user's reply to the ask-user step that paused it.
  reply?: string
  // Scheduled/triggered runs execute the PUBLISHED graph; a manual builder run
  // executes the working draft so you can test before publishing.
  usePublished?: boolean
  // How this run was started — persisted on the FlowRun for provenance.
  trigger?: { type: 'manual' | 'schedule' | 'webhook'; [key: string]: unknown }
}

// Bound HTTP responses so downstream prompts/logs stay manageable.
const HTTP_MAX_RESPONSE_CHARS = 50_000

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Run a flow to completion. Each agent node delegates to the real agent runtime
 * (runAgentExecution) and is recorded as a FlowRunStep so the builder canvas can
 * poll live per-step status. Returns the terminal run status + output.
 */
export async function runFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const source = job.usePublished && flow.publishedGraph != null ? flow.publishedGraph : flow.graph
  const graph = flowGraphSchema.parse(source)
  const input = job.input ?? ''
  const resuming = Boolean(job.flowRunId && job.reply !== undefined)
  const usedConnectionIds = Array.from(new Set(graph.nodes.filter((node) => node.type === 'tool').map((node) => node.data.connectionId).filter(Boolean)))
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: job.organizationId, status: 'ACTIVE' },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(job.organizationId, { connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }

  // Required trigger inputs (declared on the trigger node) must be present.
  // Skipped when resuming: the original input was validated on the first run.
  if (!resuming) {
    const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
    const missing = missingRequiredInputFields(inputFields, input)
    if (missing.length) {
      throw new ApiError(
        `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
        400,
        'FLOW_INPUT_ERROR',
      )
    }
  }
  const run = job.flowRunId
    ? await prisma.flowRun.update({ where: { id: job.flowRunId }, data: { status: 'running' } })
    : await prisma.flowRun.create({
        data: {
          flowId: flow.id,
          status: 'running',
          input: { prompt: input },
          trigger: jsonValue(job.trigger ?? { type: 'manual' }),
          graphSnapshot: jsonValue(graph),
          organizationId: job.organizationId,
          userId: job.userId,
        },
      })

  // Resume state: nodes that already succeeded are skipped (reusing their
  // stored output); the paused step is re-run with the reply injected.
  const completed: Record<string, unknown> = {}
  let resumeNodeId: string | undefined
  let resumeExecutionId: string | undefined
  if (resuming) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    for (const step of priorSteps) {
      if (step.status === 'succeeded' || step.status === 'skipped') completed[step.nodeId] = step.output
      if (step.status === 'waiting') {
        resumeNodeId = step.nodeId
        resumeExecutionId = step.agentExecutionId ?? undefined
      }
    }
  }

  const nodeTypeById = new Map(graph.nodes.map((node) => [node.id, node.type]))
  let order = 0
  // Container (condition/loop/parallel/stop) outcomes are reported via onStep;
  // persist them so runs are fully inspectable. Agent/tool/http steps are
  // persisted by their adapters because they need started/running rows.
  const pending: Promise<unknown>[] = []
  const onStep = (outcome: { nodeId: string; status: string; output?: unknown; error?: string }) => {
    if (!shouldPersistInterpreterStep(nodeTypeById.get(outcome.nodeId))) return
    pending.push(
      prisma.flowRunStep
        .create({
          data: {
            flowRunId: run.id,
            nodeId: outcome.nodeId,
            order: order++,
            status: outcome.status,
            output: jsonValue(outcome.output ?? null),
            error: outcome.error ? outcome.error.slice(0, 300) : null,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined),
    )
  }

  // Adapter: each agent node runs the real agent and records a FlowRunStep row.
  const runAgent: RunAgentFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        input: { prompt: node.input },
        startedAt: new Date(),
      },
    })
    try {
      // Resuming this node? Re-enter the paused agent execution with the reply.
      const resumeThis = node.resume && resumeNodeId === node.id && resumeExecutionId
      const result = (await runAgentExecution(
        resumeThis
          ? { agentId: node.agentId, organizationId: job.organizationId, userId: job.userId, executionId: resumeExecutionId, resume: true, reply: job.reply }
          : { agentId: node.agentId, organizationId: job.organizationId, userId: job.userId, input: node.input },
      )) as { summary?: string; status?: string; question?: string; executionId?: string }

      if (typeof result?.status === 'string' && result.status.startsWith('waiting')) {
        await prisma.flowRunStep.update({
          where: { id: step.id },
          data: { status: 'waiting', agentExecutionId: result.executionId ?? null, finishedAt: new Date() },
        })
        return { waiting: { status: result.status, question: result.question } }
      }
      const output = result?.summary ?? ''
      await prisma.flowRunStep.update({
        where: { id: step.id },
        data: { status: 'succeeded', output: jsonValue(output), agentExecutionId: result.executionId ?? null, finishedAt: new Date() },
      })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.flowRunStep.update({
        where: { id: step.id },
        data: { status: 'failed', error: message.slice(0, 300), finishedAt: new Date() },
      })
      return { error: message }
    }
  }

  // Deterministic steps: MCP tool calls and HTTP requests. Same FlowRunStep
  // bookkeeping as agent steps so the run panel shows their input/output.
  const runAction: RunActionFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        input: jsonValue(node.config),
        startedAt: new Date(),
      },
    })
    const finish = async (patch: { status: string; output?: unknown; error?: string }) => {
      await prisma.flowRunStep.update({
        where: { id: step.id },
        data: {
          status: patch.status,
          output: patch.output !== undefined ? jsonValue(patch.output) : undefined,
          error: patch.error ? patch.error.slice(0, 300) : undefined,
          finishedAt: new Date(),
        },
      })
    }
    try {
      if (node.kind === 'tool') {
        const connectionId = String(node.config.connectionId || '')
        const conn = await prisma.mcpConnection.findFirst({
          where: { id: connectionId, organizationId: job.organizationId, isActive: true },
        })
        if (!conn) throw new Error('The selected connection no longer exists — pick another in the step config.')
        const fresh = await ensureFreshConnectionToken(conn)
        const client = new McpClient(mcpConfigFromConnection(fresh))
        const args = prepareToolArgs(node.config.args)
        const toolName = String(node.config.toolName)
        const retries = flowActionRetries(node.config.retries)
        const timeoutMs = flowActionTimeoutMs(node.config.timeoutMs)
        const output = await runWithRetries(
          async () => flowToolOutput(await client.executeTool(fresh.serverUrl, toolName, args)),
          {
            retries,
            timeoutMs,
            timeoutMessage: timeoutMs ? `Tool ${toolName} timed out after ${timeoutMs}ms` : undefined,
          },
        )
        await finish({ status: 'succeeded', output })
        return { output }
      }
      // http
      const request = prepareHttpRequest(node.config)
      const retries = flowActionRetries(node.config.retries)
      const output = await runWithRetries(async () => {
        await assertPublicUrl(request.url) // SSRF guard: re-check before every attempt
        const controller = new AbortController()
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs)
        try {
          const response = await fetch(request.url, { ...request.init, signal: controller.signal })
          const nextOutput = await responseOutput(response, request.responseType, HTTP_MAX_RESPONSE_CHARS)
          if (request.failOnHttpError && !nextOutput.ok) throw new Error(`HTTP ${nextOutput.status}: ${nextOutput.bodyText.slice(0, 200)}`)
          return nextOutput
        } catch (error) {
          if (timedOut) throw new Error(`HTTP request timed out after ${request.timeoutMs}ms`)
          throw error
        } finally {
          clearTimeout(timer)
        }
      }, { retries })
      await finish({ status: 'succeeded', output })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finish({ status: 'failed', error: message })
      return { error: message }
    }
  }

  const result = await interpretFlow(graph, input, {
    runAgent,
    runAction,
    onStep,
    ...(resuming ? { completed, resumeNodeId } : {}),
  })
  await Promise.all(pending) // ensure all container-step rows are written
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'waiting' ? 'waiting' : 'failed'
  await prisma.flowRun.update({
    where: { id: run.id },
    data: { status, output: jsonValue(result.output), finishedAt: status === 'waiting' ? null : new Date() },
  })
  return { flowRunId: run.id, status, output: result.output }
}
