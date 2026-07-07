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

  let order = 0
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
      const result = (await runAgentExecution({
        agentId: node.agentId,
        organizationId: job.organizationId,
        userId: job.userId,
        input: node.input,
      })) as { summary?: string; status?: string; question?: string }

      if (typeof result?.status === 'string' && result.status.startsWith('waiting')) {
        await prisma.flowRunStep.update({ where: { id: step.id }, data: { status: 'waiting', finishedAt: new Date() } })
        return { waiting: { status: result.status, question: result.question } }
      }
      const output = result?.summary ?? ''
      await prisma.flowRunStep.update({
        where: { id: step.id },
        data: { status: 'succeeded', output: jsonValue(output), finishedAt: new Date() },
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

  const result = await interpretFlow(graph, input, { runAgent })
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'waiting' ? 'waiting' : 'failed'
  await prisma.flowRun.update({
    where: { id: run.id },
    data: { status, output: jsonValue(result.output), finishedAt: status === 'waiting' ? null : new Date() },
  })
  return { flowRunId: run.id, status, output: result.output }
}
