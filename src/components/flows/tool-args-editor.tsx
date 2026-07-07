'use client'

import { useState } from 'react'
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

function parseArgs(args: string | undefined): Record<string, string> {
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

/** Re-serialize form values to a JSON args string, coercing where the schema says so. */
function serializeArgs(values: Record<string, string>, fields: SchemaField[]): string {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    // Leave {{token}} values as strings — they're resolved at run time.
    if (raw.includes('{{')) {
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

  const values = parseArgs(args)
  const setValue = (name: string, value: string) => onChange(serializeArgs({ ...values, [name]: value }, fields))
  const insert = (token: string) => {
    if (raw || !activeArg) return
    setValue(activeArg, `${values[activeArg] ?? ''}${token}`)
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
        <textarea
          rows={5}
          className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
          value={args ?? '{}'}
          placeholder={'{"query": "{{trigger.input}}"}'}
          onChange={(e) => onChange(e.target.value)}
        />
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
                <select className={fieldClass} value={values[field.name] ?? ''} onFocus={() => setActiveArg(field.name)} onChange={(e) => setValue(field.name, e.target.value)}>
                  <option value="">—</option>
                  {field.enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select className={fieldClass} value={values[field.name] ?? ''} onFocus={() => setActiveArg(field.name)} onChange={(e) => setValue(field.name, e.target.value)}>
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  placeholder={field.description || `{{trigger.input}}`}
                  onFocus={() => setActiveArg(field.name)}
                  onChange={(e) => setValue(field.name, e.target.value)}
                />
              )}
              {field.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>}
            </div>
          ))}
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Insert data into “{activeArg ?? '…'}”</p>
            <DataTree fields={dataFields} onInsert={insert} />
          </div>
        </div>
      )}
    </div>
  )
}
