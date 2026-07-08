'use client'

import { useRef, useState } from 'react'
import { Code2, ListTree } from 'lucide-react'
import { DataTree } from '@/components/flows/data-tree'
import type { DataField } from '@/lib/flows/datatree'

type JsonSchema = {
  type?: string
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>
  required?: string[]
}

export type SchemaField = { name: string; type: string; required: boolean; description?: string; enumValues?: string[] }

/** Flatten a tool's top-level JSON-schema object into form fields. */
export function schemaFields(inputSchema: unknown): SchemaField[] {
  const schema = inputSchema as JsonSchema | null
  if (!schema || schema.type !== 'object' || !schema.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: prop.type ?? 'string',
    required: required.has(name),
    description: prop.description,
    enumValues: Array.isArray(prop.enum) ? prop.enum.map(String) : undefined,
  }))
}

export function parseArgs(args: string | undefined): Record<string, string> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) out[k] = typeof v === 'string' ? v : JSON.stringify(v)
      return out
    }
  } catch {
    /* not JSON yet */
  }
  return {}
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

function isJsonValueField(field: SchemaField): boolean {
  return ['object', 'array', 'any'].includes(field.type)
}

/** Re-serialize form values to a JSON args string, coercing where the schema says so. */
export function serializeArgs(values: Record<string, string>, fields: SchemaField[]): string {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    const parsed = isJsonValueField(field) ? parseJsonLike(raw) : undefined
    if (parsed !== undefined) {
      out[field.name] = parsed
    } else if (raw.includes('{{')) {
      // Exact-token object/array values are preserved by resolveTemplateValue at runtime.
      out[field.name] = raw
    } else if (field.type === 'number' || field.type === 'integer') {
      const n = Number(raw)
      out[field.name] = Number.isNaN(n) ? raw : n
    } else if (field.type === 'boolean') {
      out[field.name] = raw === 'true'
    } else {
      out[field.name] = raw
    }
  }
  return JSON.stringify(out, null, 2)
}

function placeholderFor(field: SchemaField): string {
  if (field.description) return field.description
  if (field.type === 'object') return '{"id": "{{trigger.input.id}}"} or {{trigger.input.record}}'
  if (field.type === 'array') return '["one", "two"] or {{trigger.input.items}}'
  if (field.type === 'any') return 'Text, JSON, or a value from Available data'
  return 'Add a value or choose one below'
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * Renders a tool's arguments from its JSON-schema as real form fields (with a
 * datatree token picker), or falls back to a raw-JSON editor for tools whose
 * schema is unknown or when the user opts into advanced mode.
 */
export function ToolArgsEditor({
  inputSchema,
  args,
  onChange,
  dataFields,
}: {
  inputSchema: unknown
  args: string | undefined
  onChange: (nextArgs: string) => void
  dataFields: DataField[]
}) {
  const fields = schemaFields(inputSchema)
  const [raw, setRaw] = useState(fields.length === 0)
  // Which arg the datatree inserts into (append at end of that field's value).
  const [activeArg, setActiveArg] = useState<string | null>(fields[0]?.name ?? null)
  const activeElRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const rawElRef = useRef<HTMLTextAreaElement | null>(null)

  const values = parseArgs(args)
  const setValue = (name: string, value: string) => onChange(serializeArgs({ ...values, [name]: value }, fields))
  const insertAtCaret = (value: string, token: string, el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!el || typeof el.selectionStart !== 'number') return value + token
    const start = el.selectionStart
    const end = el.selectionEnd ?? start
    const next = value.slice(0, start) + token + value.slice(end)
    const pos = start + token.length
    requestAnimationFrame(() => {
      try {
        el.focus()
        el.setSelectionRange(pos, pos)
      } catch {
        /* element unmounted */
      }
    })
    return next
  }
  const insert = (token: string) => {
    if (raw) {
      onChange(insertAtCaret(args ?? '{}', token, rawElRef.current))
      return
    }
    if (!activeArg) return
    setValue(activeArg, insertAtCaret(values[activeArg] ?? '', token, activeElRef.current))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className={`${labelClass} mb-0`}>Arguments</label>
        {fields.length > 0 && (
          <button
            type="button"
            onClick={() => setRaw((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-indigo-600"
          >
            {raw ? <ListTree className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {raw ? 'Form' : 'Raw JSON'}
          </button>
        )}
      </div>

      {raw || fields.length === 0 ? (
        <div className="space-y-2">
          <textarea
            ref={rawElRef}
            rows={5}
            className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
            value={args ?? '{}'}
            placeholder={'{"query": "Use a value from Available data"}'}
            onFocus={() => {
              activeElRef.current = rawElRef.current
            }}
            onChange={(e) => onChange(e.target.value)}
          />
          <DataTree fields={dataFields} onInsert={insert} />
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((field) => (
            <div key={field.name}>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                <span className="font-mono">{field.name}</span>
                {field.required && <span className="text-red-500">*</span>}
                <span className="text-[10px] uppercase text-muted-foreground">{field.type}</span>
              </label>
              {field.enumValues ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  onFocus={() => {
                    setActiveArg(field.name)
                    activeElRef.current = null
                  }}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  {field.enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  onFocus={() => {
                    setActiveArg(field.name)
                    activeElRef.current = null
                  }}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : isJsonValueField(field) ? (
                <textarea
                  rows={field.type === 'array' || field.type === 'object' ? 4 : 2}
                  className={`${fieldClass} min-h-[76px] resize-y font-mono text-xs`}
                  value={values[field.name] ?? ''}
                  placeholder={placeholderFor(field)}
                  onFocus={(e) => {
                    setActiveArg(field.name)
                    activeElRef.current = e.currentTarget
                  }}
                  onChange={(e) => setValue(field.name, e.target.value)}
                />
              ) : (
                <input
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  placeholder={placeholderFor(field)}
                  onFocus={(e) => {
                    setActiveArg(field.name)
                    activeElRef.current = e.currentTarget
                  }}
                  onChange={(e) => setValue(field.name, e.target.value)}
                />
              )}
              {field.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>}
            </div>
          ))}
          <div>
            <DataTree fields={dataFields} onInsert={insert} />
          </div>
        </div>
      )}
    </div>
  )
}
