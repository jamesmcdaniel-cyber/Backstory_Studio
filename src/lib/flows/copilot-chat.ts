import { flowGraphSchema } from '@/lib/flows/graph'
import { copilotOpSchema, type CopilotOp } from '@/lib/flows/copilot-ops'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, type FlowCopilotToolCatalog } from '@/lib/flows/copilot'

/**
 * Pure helpers for the conversational copilot chat endpoint: tolerant parsing
 * of the model's {message, opsJson} structured reply, and sanitization of the
 * candidate ops so the route NEVER returns raw unvalidated model output.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Strip a surrounding ```json fence (if any) before JSON.parse. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

export type CopilotChatReply = {
  message: string
  /** Raw candidate op objects, NOT yet validated — feed to sanitizeCopilotOps. */
  candidates: unknown[]
  /** True when the model emitted ops we could not read at all (counts as one discard). */
  opsUnreadable: boolean
}

/**
 * Tolerantly extract {message, candidates} from a structured-output reply
 * shaped as {"message": "...", "opsJson": "[...]"}. Accepts a direct `ops`
 * array too (in case the model ignores the string wrapper), and strips
 * ```json fences from the inner string before parsing. A missing/empty ops
 * payload is a normal no-change reply; an unreadable one sets opsUnreadable.
 */
export function parseCopilotChatReply(raw: string): CopilotChatReply {
  let outer: unknown
  try {
    outer = JSON.parse(stripFences(raw))
  } catch {
    return { message: '', candidates: [], opsUnreadable: true }
  }
  if (!isRecord(outer)) return { message: '', candidates: [], opsUnreadable: true }
  const message = typeof outer.message === 'string' ? outer.message : ''
  if (Array.isArray(outer.ops)) return { message, candidates: outer.ops, opsUnreadable: false }
  if (outer.opsJson === undefined) return { message, candidates: [], opsUnreadable: false }
  if (typeof outer.opsJson !== 'string') return { message, candidates: [], opsUnreadable: true }
  if (!outer.opsJson.trim()) return { message, candidates: [], opsUnreadable: false }
  try {
    const parsed = JSON.parse(stripFences(outer.opsJson))
    if (Array.isArray(parsed)) return { message, candidates: parsed, opsUnreadable: false }
    // A single op object (not wrapped in an array) is close enough to accept.
    if (isRecord(parsed)) return { message, candidates: [parsed], opsUnreadable: false }
    return { message, candidates: [], opsUnreadable: true }
  } catch {
    return { message, candidates: [], opsUnreadable: true }
  }
}

/**
 * Validate every candidate op through copilotOpSchema and, for replace ops,
 * parse + normalize + schema-validate + repair the embedded graphJson, then
 * attach the sanitized result as `op.graph` (the wire schema strips any
 * model-supplied `graph` key, so only this server-attached graph ever exists).
 * Invalid or unrepairable candidates are dropped and counted.
 */
export function sanitizeCopilotOps(
  candidates: unknown[],
  context: { agents: { id: string }[]; toolCatalog: FlowCopilotToolCatalog },
): { ops: CopilotOp[]; discarded: number } {
  const ops: CopilotOp[] = []
  let discarded = 0
  for (const candidate of candidates) {
    const parsed = copilotOpSchema.safeParse(candidate)
    if (!parsed.success) {
      discarded += 1
      continue
    }
    if (parsed.data.op !== 'replace') {
      ops.push(parsed.data as CopilotOp)
      continue
    }
    try {
      const graph = repairGeneratedFlowGraph(
        flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(JSON.parse(stripFences(parsed.data.graphJson)))),
        context,
      )
      // Echo the CANONICAL serialization, not the model's original (possibly
      // fenced, pre-repair) string, so graphJson and graph always agree.
      ops.push({ op: 'replace', graphJson: JSON.stringify(graph), graph })
    } catch {
      discarded += 1
    }
  }
  return { ops, discarded }
}

/** The sentence appended to `message` when any ops were dropped. */
export function discardNotice(count: number): string {
  return ` (I discarded ${count} change${count === 1 ? '' : 's'} that didn't validate.)`
}
