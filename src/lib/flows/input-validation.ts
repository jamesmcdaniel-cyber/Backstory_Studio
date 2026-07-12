import type { TriggerInputField } from '@/lib/flows/graph'

/**
 * A value counts as absent for input purposes when it is undefined, null, or a
 * blank/whitespace-only string. `false` and `0` are real values. Shared by the
 * required-check and the default-fill so they agree on what "not supplied"
 * means — a field filled from its default is therefore never later flagged
 * missing.
 */
function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
}

/**
 * Names of required trigger input fields the run payload does not supply.
 * Empty strings and null are treated as missing; false and 0 are values.
 */
export function missingRequiredInputFields(fields: TriggerInputField[], input: unknown): string[] {
  const required = fields.filter((field) => field.required && field.name.trim())
  if (!required.length) return []
  const record =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  return required.map((field) => field.name.trim()).filter((name) => isBlankValue(record?.[name]))
}

/**
 * Fill absent/blank structured inputs from each field's declared `default`.
 * Deterministic and pure — never mutates `input`, returns the merged value.
 *
 * Precedence: an explicit provided value ALWAYS wins over a field default
 * (only absent/blank values are filled). Defaults apply to STRUCTURED (object)
 * input only — a bare string/number/array is a single opaque payload and is
 * returned unchanged. A field with no non-blank default is left as-is, so a
 * required field lacking both a value and a default still reads as missing and
 * can fall through to the last-successful-reuse fallback in execute-flow.
 */
export function applyInputDefaults(fields: Array<{ name: string; default?: string }>, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const next: Record<string, unknown> = { ...record }
  for (const field of fields) {
    const name = field.name?.trim()
    if (!name) continue
    const def = field.default
    if (typeof def === 'string' && def.trim() !== '' && isBlankValue(next[name])) next[name] = def
  }
  return next
}
