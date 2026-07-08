/** Parse user-entered or integration-sent flow input while preserving plain text. */
export function parseFlowInput(value: unknown): unknown {
  if (value == null) return ''
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/**
 * Webhook convention: when callers send `{ input: ... }`, that field is the
 * flow input. Otherwise the full JSON body is the flow input.
 */
export function flowInputFromWebhookBody(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'input')) {
    return parseFlowInput((body as Record<string, unknown>).input)
  }
  return parseFlowInput(body)
}
