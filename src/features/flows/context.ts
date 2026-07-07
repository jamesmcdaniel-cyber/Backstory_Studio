import type { ConditionOp } from '@/lib/flows/graph'

/**
 * The evaluation context threaded through a flow run: the trigger input, every
 * completed step's output keyed by node id, and (inside a loop) the current item.
 */
export type FlowContext = {
  trigger: { input: unknown }
  step: Record<string, { output: unknown }>
  item?: unknown
}

/** Read a dot-path off the context (e.g. 'trigger.input', 'step.n1.output.score', 'item'). */
export function readPath(ctx: FlowContext, path: string): unknown {
  const parts = path.trim().split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Replace `{{path}}` tokens with values from the context. Objects → JSON; missing → ''. */
export function resolveTemplate(template: string, ctx: FlowContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(ctx, path)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/** A step's text output that parses as a JSON object/array is exposed structured. */
export function asStructured(output: unknown): unknown {
  if (typeof output !== 'string') return output
  const trimmed = output.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return output
  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

/** Coerce a string to a number when it looks numeric, so comparisons order correctly. */
function coerce(value: string): number | string {
  const n = Number(value)
  return value.trim() !== '' && !Number.isNaN(n) ? n : value
}

/** Evaluate a structured condition against the context. Never runs arbitrary code. */
export function evalCondition(cond: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean {
  const leftRaw = resolveTemplate(cond.left, ctx)
  const rightRaw = cond.right
  switch (cond.op) {
    case 'contains':
      return leftRaw.includes(rightRaw)
    case 'matches':
      try {
        return new RegExp(rightRaw).test(leftRaw)
      } catch {
        return false
      }
    default: {
      const l = coerce(leftRaw)
      const r = coerce(rightRaw)
      switch (cond.op) {
        case 'eq':
          return l === r
        case 'neq':
          return l !== r
        case 'gt':
          return l > r
        case 'gte':
          return l >= r
        case 'lt':
          return l < r
        case 'lte':
          return l <= r
      }
    }
  }
  return false
}
