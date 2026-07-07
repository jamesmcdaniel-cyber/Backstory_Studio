import { prisma } from '@/lib/prisma'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { interpretFlow, type RunAgentFn } from './interpret'

export type FlowExecutionJob = {
  flowId: string
  organizationId: string
  userId: string
  input?: string
  flowRunId?: string
  // Resume a paused run: the user's reply to the ask-user step that paused it.
  reply?: string
}

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
  const graph = flowGraphSchema.parse(flow.graph)
  const input = job.input ?? ''

  const resuming = Boolean(job.flowRunId && job.reply !== undefined)
  const run = job.flowRunId
    ? await prisma.flowRun.update({ where: { id: job.flowRunId }, data: { status: 'running' } })
    : await prisma.flowRun.create({
        data: {
          flowId: flow.id,
          status: 'running',
          input: { prompt: input },
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
  // persist them so runs are fully inspectable, not just their agent steps.
  const pending: Promise<unknown>[] = []
  const onStep = (outcome: { nodeId: string; status: string; output?: unknown; error?: string }) => {
    if (nodeTypeById.get(outcome.nodeId) === 'agent') return // agent rows handled by the adapter below
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

  const result = await interpretFlow(graph, input, {
    runAgent,
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
