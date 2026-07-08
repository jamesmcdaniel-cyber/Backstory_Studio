import type { OutputField } from '@/lib/flows/graph'
import { parseFlowInput } from '@/lib/flows/input'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringifyFieldValue(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function parseJsonLike(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function coerceFieldValue(field: OutputField, raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (field.type === 'number') {
    const number = Number(trimmed)
    return Number.isNaN(number) ? raw : number
  }
  if (field.type === 'boolean') return trimmed === 'true'
  if (field.type === 'object' || field.type === 'array' || field.type === 'any') {
    const parsed = parseJsonLike(raw)
    return parsed === undefined ? raw : parsed
  }
  return raw
}

export function fieldValuesFromFlowInput(input: string, fields: OutputField[]): Record<string, string> {
  const parsed = parseFlowInput(input)
  if (!isRecord(parsed)) return {}
  const values: Record<string, string> = {}
  for (const field of fields) {
    const name = field.name.trim()
    if (!name || !Object.prototype.hasOwnProperty.call(parsed, name)) continue
    values[name] = stringifyFieldValue(parsed[name])
  }
  return values
}

export function flowInputFromFieldValues(fields: OutputField[], values: Record<string, string>): string {
  const payload: Record<string, unknown> = {}
  for (const field of fields) {
    const name = field.name.trim()
    if (!name) continue
    const value = coerceFieldValue(field, values[name] ?? '')
    if (value !== undefined) payload[name] = value
  }
  return JSON.stringify(payload, null, 2)
}
