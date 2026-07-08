export type FlowHttpConfig = {
  method?: unknown
  url?: unknown
  query?: unknown
  headers?: unknown
  body?: unknown
  bodyMode?: unknown
  responseType?: unknown
  failOnHttpError?: unknown
  retries?: unknown
  timeoutMs?: unknown
}

export type FlowHttpOutput = {
  ok: boolean
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  body: unknown
  bodyText: string
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])
const JSON_RE = /^(?:\{|\[|true|false|null|-?\d|")/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseObjectInput(value: unknown, label: string): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON object.`)
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    /* throw below */
  }
  throw new Error(`${label} must be a JSON object.`)
}

function stringifyHeaderValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function headersFrom(value: unknown): Record<string, string> {
  const parsed = parseObjectInput(value, 'Headers')
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, item]) => [key, stringifyHeaderValue(item)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0].trim()) && entry[1] !== undefined),
  )
}

function queryUrl(url: string, query: unknown): string {
  const params = parseObjectInput(query, 'Query params')
  if (!Object.keys(params).length) return url
  const next = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (!key.trim() || value == null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && item !== '') next.searchParams.append(key, String(item))
      }
      continue
    }
    next.searchParams.set(key, String(value))
  }
  return next.toString()
}

function explicitBodyMode(value: unknown): 'json' | 'text' | 'none' | undefined {
  return value === 'json' || value === 'text' || value === 'none' ? value : undefined
}

function inferBodyMode(body: unknown): 'json' | 'text' | 'none' {
  if (body == null || body === '') return 'none'
  if (typeof body !== 'string') return 'json'
  return JSON_RE.test(body.trim()) ? 'json' : 'text'
}

function jsonBody(body: unknown): string | undefined {
  if (body == null || body === '') return undefined
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (!trimmed) return undefined
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      throw new Error('HTTP body is not valid JSON after template substitution.')
    }
  }
  return JSON.stringify(body)
}

function textBody(body: unknown): string | undefined {
  if (body == null) return undefined
  return typeof body === 'string' ? body : JSON.stringify(body)
}

export function prepareHttpRequest(config: FlowHttpConfig): { url: string; init: RequestInit; timeoutMs: number; failOnHttpError: boolean; responseType: 'auto' | 'json' | 'text' } {
  const method = String(config.method || 'POST').toUpperCase()
  const url = queryUrl(String(config.url || ''), config.query)
  const headers = headersFrom(config.headers)
  const mode = explicitBodyMode(config.bodyMode) ?? inferBodyMode(config.body)
  const bodyAllowed = BODY_METHODS.has(method)
  let body: string | undefined
  if (bodyAllowed && mode !== 'none') {
    body = mode === 'json' ? jsonBody(config.body) : textBody(config.body)
    if (mode === 'json' && body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json'
    }
  }
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.min(120000, Math.round(config.timeoutMs)))
    : 30_000
  const responseType = config.responseType === 'json' || config.responseType === 'text' ? config.responseType : 'auto'
  return {
    url,
    init: { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'error' },
    timeoutMs,
    failOnHttpError: config.failOnHttpError !== false,
    responseType,
  }
}

function shouldParseJson(contentType: string, responseType: 'auto' | 'json' | 'text', text: string) {
  if (responseType === 'text') return false
  if (responseType === 'json') return true
  return contentType.toLowerCase().includes('json') || JSON_RE.test(text.trim())
}

export async function responseOutput(response: Response, responseType: 'auto' | 'json' | 'text', maxChars = 50_000): Promise<FlowHttpOutput> {
  const bodyText = (await response.text()).slice(0, maxChars)
  const headers = Object.fromEntries(response.headers.entries())
  let body: unknown = bodyText
  if (bodyText && shouldParseJson(headers['content-type'] ?? '', responseType, bodyText)) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      if (responseType === 'json') throw new Error('HTTP response was not valid JSON.')
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    body,
    bodyText,
  }
}
