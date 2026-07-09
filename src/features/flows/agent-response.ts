import type { OutputField } from '@/lib/flows/graph'

/**
 * Instruction appended to an agent step's input when the step declares a
 * structured response. Kept prompt-only: the agent runtime has no schema
 * channel, so the contract is enforced by parseStructuredAgentOutput below.
 */
export function structuredResponseInstruction(fields: OutputField[]): string {
  const lines = fields
    .filter((field) => field.name.trim())
    .map((field) => `- "${field.name.trim()}" (${field.type}${field.description ? `): ${field.description}` : ')'}`)
  return [
    'Respond ONLY with a single JSON object (no prose, no code fences) containing exactly these properties:',
    ...lines,
  ].join('\n')
}

/** Pull a JSON object out of an agent reply that may include fences or prose. */
function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Validate a structured agent reply against the step's declared output fields.
 * Returns the parsed object, or an actionable error for the run panel.
 */
export function parseStructuredAgentOutput(
  output: unknown,
  fields: OutputField[],
): { output?: Record<string, unknown>; error?: string } {
  const record =
    typeof output === 'string'
      ? extractJsonObject(output)
      : output && typeof output === 'object' && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : undefined
  if (!record) {
    return { error: 'The agent did not return the JSON object this step requires. Adjust the agent instructions or switch the response format to Text only.' }
  }
  const missing = fields.map((field) => field.name.trim()).filter((name) => name && record[name] === undefined)
  if (missing.length) {
    return { error: `The agent response is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.` }
  }
  return { output: record }
}
