import { prisma } from '@/lib/prisma'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { createApproval, capabilityFromProvider } from '@/lib/agents/approval'
import { parseApprovalDecision, shouldConsumeApprovalDecision } from '@/lib/flows/approval-decision'
import { notify } from '@/lib/notifications/service'
import { recordAudit } from '@/lib/audit'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError } from '@/lib/server/api-handler'
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { missingRequiredInputFields } from '@/lib/flows/input-validation'
import { interpretFlow, type RunAgentFn, type RunActionFn } from './interpret'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries } from './action-reliability'
import { prepareHttpRequest, responseOutput, redactHttpStepInput, withBearerAuthorization } from './http'
import { resolveHttpConnectionToken } from './http-auth'
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
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal'; [key: string]: unknown }
}

// Bound HTTP responses so downstream prompts/logs stay manageable.
const HTTP_MAX_RESPONSE_CHARS = 50_000

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// Write planes are the consequential audit entries — the same set the agent
// loop uses for its tool.write / tool.call distinction.
const WRITE_PLANES = /^(nango|slack|email|backstory)/i

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
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, toolCatalog] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: job.organizationId, status: 'ACTIVE' },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(job.organizationId, { userId: job.userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
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
  // Approval ids persisted on the run's waiting step rows. A resuming tool
  // step may only consume a decision reply whose approvalId is in this set —
  // and each id is consumed at most once — so in loops/parallel one item's
  // decision is never reported as another item's result.
  const pausedApprovalIds = new Set<string>()
  let order = 0
  if (resuming) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    for (const step of priorSteps) {
      if (step.status === 'succeeded' || step.status === 'skipped') completed[step.nodeId] = step.output
      if (step.status === 'waiting') {
        resumeNodeId = step.nodeId
        resumeExecutionId = step.agentExecutionId ?? undefined
        const approvalId = (step.output as { waiting?: { approvalId?: string } } | null)?.waiting?.approvalId
        if (typeof approvalId === 'string' && approvalId) pausedApprovalIds.add(approvalId)
      }
    }
    // Resuming creates NEW step rows for the re-run node — resolve every stale
    // waiting row now so it can never shadow a later pause in deriveRunWaiting,
    // and continue the order counter after all prior rows so new steps always
    // sort after old ones.
    await prisma.flowRunStep.updateMany({
      where: { flowRunId: run.id, status: 'waiting' },
      data: { status: 'resumed', finishedAt: new Date() },
    })
    // A resumed run's un-decided approvals are stale: any step that doesn't
    // consume THIS decision falls through and re-queues a fresh approval, so
    // an old pending one must never stay actionable (approving both would run
    // the write twice). decideApproval refuses non-pending requests, so a
    // superseded approval is inert — deciding it just reports its state.
    await prisma.approvalRequest.updateMany({
      where: { organizationId: job.organizationId, executionId: run.id, status: 'pending' },
      data: { status: 'superseded' },
    })
    if (priorSteps.length) order = Math.max(...priorSteps.map((step) => step.order)) + 1
  }

  const nodeTypeById = new Map(graph.nodes.map((node) => [node.id, node.type]))
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
        // Persist the pause reason on the step so the runs API can surface it.
        // The resume scan only reuses output for succeeded/skipped steps, so
        // this waiting-info output never leaks into resumed step data.
        const kind = result.status === 'waiting_for_approval' ? 'approval' : 'input'
        await prisma.flowRunStep.update({
          where: { id: step.id },
          data: {
            status: 'waiting',
            agentExecutionId: result.executionId ?? null,
            output: jsonValue({ waiting: { kind, question: result.question, approvalId: (result as { approvalId?: string }).approvalId } }),
            finishedAt: new Date(),
          },
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
        // Persisted request details must never contain credentials: an http
        // step's Authorization header value is replaced with 'redacted'.
        input: jsonValue(node.kind === 'http' ? redactHttpStepInput(node.config) : node.config),
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
        // Tool steps route by connection-id prefix to the right tool plane
        // (People.ai / Klavis / MCP / native / Nango) — the same planes and
        // executors the agent runtime uses. See @/lib/flows/tool-connection-id.
        const connectionId = String(node.config.connectionId || '')
        const { plane, ref } = parseFlowToolConnectionId(connectionId)
        const toolName = String(node.config.toolName)

        // Re-entering a step paused on an approval: the reply carries the
        // decision (decideApproval already executed an approved write, exactly
        // as it does for agent runs) — consume it, never re-execute the write.
        // CORRELATED consume only: the decision must name an approvalId this
        // run actually paused on, and each decision is consumed once. A step
        // whose approval the decision does NOT match (another loop item's
        // pause) falls through and re-queues its own approval below.
        if (node.resume && typeof job.reply === 'string') {
          const decision = parseApprovalDecision(job.reply)
          if (decision && shouldConsumeApprovalDecision(decision, pausedApprovalIds)) {
            pausedApprovalIds.delete(String(decision.approvalId))
            if (decision.status === 'approved') {
              const output = decision.result ?? { status: 'approved', executed: decision.executed === true }
              await finish({ status: 'succeeded', output })
              return { output }
            }
            const message = 'The approver rejected this action.'
            await finish({ status: 'failed', error: message })
            return { error: message }
          }
        }

        const args = prepareToolArgs(node.config.args)
        const executor = await resolveFlowToolExecutor({
          organizationId: job.organizationId,
          userId: job.userId,
          plane,
          ref,
          toolName,
        })

        // Approval gate — the same semantics as agent tool calls: an outbound
        // write plane (Nango delivery) is queued for approval instead of
        // executed, and the run pauses `waiting` (kind 'approval'). The
        // decision resumes this run via the approvals route.
        if (capabilityFromProvider(executor.provider)) {
          const approval = await createApproval({
            organizationId: job.organizationId,
            executionId: run.id,
            userId: job.userId,
            provider: executor.provider,
            tool: toolName,
            args,
          })
          const question = `Approve ${toolName}?`
          await finish({ status: 'waiting', output: { waiting: { kind: 'approval', approvalId: approval.id, question } } })
          // Mirror the agent path: surface the pending approval to the user
          // (in-app + push). notify never throws into the run. Flow
          // notifications carry the FLOW id (the bell and push deep-link to
          // the flow's activity page — a flow RUN id is not resolvable by the
          // dashboard); the run id still rides in the body for reference.
          await notify({
            organizationId: job.organizationId,
            userId: job.userId,
            type: 'flow.needs_approval',
            level: 'action',
            title: `Flow "${flow.name}" needs approval`,
            body: `Approve or reject: ${toolName} (run ${run.id})`,
            executionId: flow.id,
            link: `/flows/${flow.id}/activity`,
          })
          return { waiting: { status: 'waiting_for_approval', question } }
        }

        const retries = flowActionRetries(node.config.retries)
        const timeoutMs = flowActionTimeoutMs(node.config.timeoutMs)
        const output = await runWithRetries(
          async () => flowToolOutput(await executor.execute(toolName, args)),
          {
            retries,
            timeoutMs,
            timeoutMessage: timeoutMs ? `Tool ${toolName} timed out after ${timeoutMs}ms` : undefined,
          },
        )
        // Immutable audit trail, mirroring the agent loop's tool execution:
        // every plane is recorded; write/delivery planes are the consequential
        // ones. Args are hashed by recordAudit, never stored raw.
        await recordAudit({
          organizationId: job.organizationId,
          executionId: run.id,
          actorUserId: job.userId,
          actorKind: 'agent',
          action: WRITE_PLANES.test(executor.provider) ? 'tool.write' : 'tool.call',
          tool: toolName,
          resourceType: executor.provider,
          payload: args,
        })
        await finish({ status: 'succeeded', output })
        return { output }
      }
      // http
      const request = prepareHttpRequest(node.config)
      // Optional connection auth: resolve a fresh token server-side and inject
      // it as the Authorization header — unless the user set their own, which
      // wins. The token lives only in the outbound request, never in the
      // persisted step input/output or logs.
      const httpConnectionId = typeof node.config.connectionId === 'string' ? node.config.connectionId.trim() : ''
      if (httpConnectionId) {
        const token = await resolveHttpConnectionToken({
          connectionId: httpConnectionId,
          organizationId: job.organizationId,
          userId: job.userId,
        })
        request.init.headers = withBearerAuthorization(request.init.headers as Record<string, string>, token)
      }
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

  // Fire the flow.completed signal for other flows listening in this org.
  // Dynamic import: signals.ts imports runFlowExecution statically (it fires
  // matched flows), so a static import here back to signals.ts would be a
  // cycle — this keeps the edge one-directional. Fire-and-forget: a signal
  // emit must never block or fail this run's completion.
  // PUBLISHED RUNS ONLY: a builder Test/Run of a draft must never chain real
  // production flows — only scheduled/webhook/signal (published) runs emit.
  if (status === 'succeeded' && job.usePublished) {
    void import('./signals')
      .then((signals) =>
        signals.emitFlowSignal({
          organizationId: job.organizationId,
          signal: 'flow.completed',
          payload: { flowId: flow.id, flowName: flow.name, output: result.output },
          sourceFlowId: flow.id,
          depth: signals.signalDepthOf(job.trigger) + 1,
        }),
      )
      .catch(() => undefined)
  }

  return { flowRunId: run.id, status, output: result.output }
}
