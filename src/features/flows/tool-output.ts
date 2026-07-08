type McpContentBlock = {
  type?: unknown
  text?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJsonLike(value: string): unknown {
  const trimmed = value.trim()
  if (!/^(?:\{|\[|true|false|null|-?\d|")/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter((block): block is McpContentBlock => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return parts.length ? parts.join('\n') : undefined
}

function structuredContent(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  if (result.structured_content !== undefined) return result.structured_content
  return undefined
}

export function flowToolOutput(result: unknown, maxChars = 50_000): unknown {
  if (typeof result === 'string') {
    const text = result.slice(0, maxChars)
    const parsed = parseJsonLike(text)
    return parsed === undefined ? text : parsed
  }
  if (!isRecord(result)) return result
  const text = textFromContent(result.content)?.slice(0, maxChars)
  if (result.isError === true) {
    throw new Error(text || 'Tool returned an error.')
  }

  const structured = structuredContent(result)
  if (structured !== undefined) return structured

  if (text !== undefined) {
    const parsed = parseJsonLike(text)
    return parsed === undefined ? text : parsed
  }

  return result
}
