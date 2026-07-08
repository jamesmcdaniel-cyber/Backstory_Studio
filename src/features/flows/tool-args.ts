function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function prepareToolArgs(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') throw new Error('Tool arguments must be a JSON object.')
  try {
    const parsed = JSON.parse(value || '{}')
    if (isRecord(parsed)) return parsed
  } catch {
    throw new Error('Tool arguments are not valid JSON after template substitution.')
  }
  throw new Error('Tool arguments must be a JSON object after template substitution.')
}
