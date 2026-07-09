import type { TriggerInputField } from '@/lib/flows/graph'

/**
 * Names of required trigger input fields the run payload does not supply.
 * Empty strings and null are treated as missing; false and 0 are values.
 */
export function missingRequiredInputFields(fields: TriggerInputField[], input: unknown): string[] {
  const required = fields.filter((field) => field.required && field.name.trim())
  if (!required.length) return []
  const record =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
  return required
    .map((field) => field.name.trim())
    .filter((name) => {
      const value = record?.[name]
      return value === undefined || value === null || (typeof value === 'string' && !value.trim())
    })
}
