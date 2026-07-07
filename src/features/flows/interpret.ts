import type { FlowGraph, FlowNode, FlowEdge } from '@/lib/flows/graph'
import { resolveTemplate, asStructured, evalCondition, type FlowContext } from './context'

export type StepOutcome = {
  nodeId: string
  status: 'succeeded' | 'failed' | 'skipped' | 'waiting'
  output?: unknown
  error?: string
}
export type RunAgentResult = { output?: unknown; error?: string; waiting?: { status: string; question?: string } }
export type RunAgentFn = (node: { id: string; agentId: string; input: string }) => Promise<RunAgentResult>
export type InterpretResult = {
  status: 'succeeded' | 'failed' | 'waiting'
  steps: StepOutcome[]
  output: unknown
  waiting?: { nodeId: string; question?: string }
}

type Opts = {
  runAgent: RunAgentFn
  maxSteps?: number
  maxLoopIterations?: number
  onStep?: (outcome: StepOutcome) => void
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Deterministically interpret a flow graph. Pure: all agent execution is
 * delegated to `opts.runAgent`, so this is fully unit-testable with a stub.
 */
export async function interpretFlow(graph: FlowGraph, input: unknown, opts: Opts): Promise<InterpretResult> {
  const maxSteps = opts.maxSteps ?? 100
  const maxLoop = opts.maxLoopIterations ?? 500
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const outgoing = (id: string, branch?: 'true' | 'false'): FlowEdge | undefined =>
    graph.edges.find((edge) => edge.source === id && (branch === undefined || edge.branch === branch || edge.branch === undefined))

  const ctx: FlowContext = { trigger: { input }, step: {} }
  const steps: StepOutcome[] = []
  let visits = 0
  let lastOutput: unknown = input

  // Run one agent node in a given context, recording the outcome.
  const runAgentNode = async (
    node: Extract<FlowNode, { type: 'agent' }>,
    localCtx: FlowContext,
    fallbackTemplate: string,
  ): Promise<{ output?: unknown; error?: string; waiting?: { status: string; question?: string } }> => {
    const resolved = resolveTemplate(node.data.input ?? fallbackTemplate, localCtx)
    const res = await opts.runAgent({ id: node.id, agentId: node.data.agentId, input: resolved })
    if (res.waiting) return { waiting: res.waiting }
    if (res.error) return { error: res.error }
    return { output: asStructured(res.output) }
  }

  // Execute a non-trigger, non-condition node against the top-level context.
  const runNode = async (node: FlowNode): Promise<{ output?: unknown; halt?: InterpretResult }> => {
    if (++visits > maxSteps) return { halt: { status: 'failed', steps, output: lastOutput } }

    if (node.type === 'agent') {
      const res = await runAgentNode(node, ctx, '{{trigger.input}}')
      if (res.waiting) {
        const outcome: StepOutcome = { nodeId: node.id, status: 'waiting' }
        steps.push(outcome)
        opts.onStep?.(outcome)
        return { halt: { status: 'waiting', steps, output: lastOutput, waiting: { nodeId: node.id, question: res.waiting.question } } }
      }
      if (res.error) {
        const outcome: StepOutcome = { nodeId: node.id, status: 'failed', error: res.error }
        steps.push(outcome)
        opts.onStep?.(outcome)
        if ((node.data.onError ?? 'stop') === 'stop') return { halt: { status: 'failed', steps, output: lastOutput } }
        return { output: undefined }
      }
      ctx.step[node.id] = { output: res.output }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output: res.output }
      steps.push(outcome)
      opts.onStep?.(outcome)
      return { output: res.output }
    }

    if (node.type === 'loop') {
      const list = asStructured(resolveTemplate(node.data.over, ctx))
      const items = Array.isArray(list) ? list.slice(0, maxLoop) : []
      const bodyNodes = node.data.body.map((id) => byId.get(id)).filter((n): n is FlowNode => Boolean(n))
      const perItem = await mapLimit(items, node.data.concurrency ?? 1, async (item) => {
        const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step }, item }
        let out: unknown = item
        for (const bodyNode of bodyNodes) {
          if (bodyNode.type !== 'agent') continue
          const res = await runAgentNode(bodyNode, branchCtx, '{{item}}')
          if (res.waiting || res.error) {
            out = undefined
            break
          }
          out = res.output
          branchCtx.step[bodyNode.id] = { output: out }
        }
        return out
      })
      ctx.step[node.id] = { output: perItem }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output: perItem }
      steps.push(outcome)
      opts.onStep?.(outcome)
      return { output: perItem }
    }

    if (node.type === 'parallel') {
      const branchOutputs = await Promise.all(
        node.data.branches.map(async (branch) => {
          const branchCtx: FlowContext = { trigger: ctx.trigger, step: { ...ctx.step } }
          let out: unknown
          for (const id of branch) {
            const bodyNode = byId.get(id)
            if (!bodyNode || bodyNode.type !== 'agent') continue
            const res = await runAgentNode(bodyNode, branchCtx, '{{trigger.input}}')
            if (res.waiting || res.error) {
              out = undefined
              break
            }
            out = res.output
            branchCtx.step[bodyNode.id] = { output: out }
          }
          return [branch[0] ?? node.id, out] as const
        }),
      )
      const merged = Object.fromEntries(branchOutputs)
      ctx.step[node.id] = { output: merged }
      const outcome: StepOutcome = { nodeId: node.id, status: 'succeeded', output: merged }
      steps.push(outcome)
      opts.onStep?.(outcome)
      return { output: merged }
    }

    return { output: undefined } // trigger — no-op
  }

  // Node ids that live inside a loop body or parallel branch must never be
  // reached by the main-chain walk; they run only via their container.
  const containedIds = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [],
    ),
  )

  let current: FlowNode | undefined = byId.get('trigger') ?? graph.nodes[0]
  while (current) {
    if (current.type === 'condition') {
      if (++visits > maxSteps) return { status: 'failed', steps, output: lastOutput }
      const branch = evalCondition(current.data, ctx) ? 'true' : 'false'
      const edge = outgoing(current.id, branch)
      current = edge ? byId.get(edge.target) : undefined
      continue
    }
    if (current.type !== 'trigger') {
      const { output, halt } = await runNode(current)
      if (halt) return halt
      if (output !== undefined) lastOutput = output
    }
    const edge = outgoing(current.id)
    let next = edge ? byId.get(edge.target) : undefined
    while (next && containedIds.has(next.id)) {
      const skip = outgoing(next.id)
      next = skip ? byId.get(skip.target) : undefined
    }
    current = next
  }

  return { status: 'succeeded', steps, output: lastOutput }
}
