'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'

/**
 * The agent configuration form, shared by the config dialog and the dashboard's
 * inline setup pane. Owns the draft state, integration/skill pickers, schedule
 * controls and the recent-runs list for an existing agent.
 */

type SkillSummary = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

type ToolChip = {
  key: string
  label: string
  slug: string
  connected: boolean
}

type ConnectionIntegration = {
  id: string
  name: string
}

type AvailableIntegrations = {
  tools: ToolChip[]
  connections: ConnectionIntegration[]
}

export type AgentDraft = {
  title: string
  description: string
  instructions: string
  model: string
  priority: string
  integrations: string[]
  skills: string[]
  icon: string
  folder: string
  visibility: 'shared' | 'private'
  schedule: {
    type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron'
    time?: string
    cron?: string
    timezone: string
    isActive: boolean
  }
}

// ~10 common IANA timezones offered in the schedule picker.
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
] as const

/** The browser's IANA timezone, falling back to UTC (e.g. during SSR). */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const emptyDraft: AgentDraft = {
  title: '',
  description: '',
  instructions: '',
  model: 'gpt-4o',
  priority: 'medium',
  integrations: [],
  skills: [],
  icon: '🤖',
  folder: '',
  visibility: 'shared',
  schedule: { type: 'manual', time: '09:00', timezone: 'UTC', isActive: false },
}

// ── Model catalog ───────────────────────────────────────────────────────────
// id must satisfy the runtime's provider routing (model-runner.ts): a `claude*`
// id routes to Anthropic, anything else to OpenAI. Claude first (platform
// default / most capable); logos rendered via IntegrationLogo (Simple Icons).
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' as const },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' as const },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' as const },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' as const },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' as const },
]

function ModelOption({ provider, label }: { provider: 'anthropic' | 'openai'; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <IntegrationLogo slug={provider} name={provider === 'anthropic' ? 'Claude' : 'OpenAI'} className="h-4 w-4" />
      {label}
    </span>
  )
}

// ── Schedule cadence (UI concept mapped onto the backend schedule) ───────────
// Backend supports type manual|hourly|daily|weekly|cron (see scheduling/due.ts).
// The UI offers friendlier cadences; "every other day" rides on cron `*/2` day.
type Cadence = 'daily' | 'every_other_day' | 'weekly' | 'custom'
const EVERY_OTHER_DAY_RE = /^\d{1,2}\s+\d{1,2}\s+\*\/2\s+\*\s+\*$/

function cadenceOf(schedule: AgentDraft['schedule']): Cadence {
  if (schedule.type === 'weekly') return 'weekly'
  if (schedule.type === 'daily') return 'daily'
  if (schedule.type === 'cron' && schedule.cron && EVERY_OTHER_DAY_RE.test(schedule.cron)) return 'every_other_day'
  return 'custom'
}

// HH:MM → an "every other day at that time" cron of the form `mm hh */2 * *`.
function everyOtherDayCron(time: string): string {
  const [hh, mm] = (time || '09:00').split(':').map((n) => parseInt(n, 10))
  return `${Number.isNaN(mm) ? 0 : mm} ${Number.isNaN(hh) ? 9 : hh} */2 * *`
}

/** Pull HH:MM out of a cron's minute+hour fields for the time input. */
function cronToTime(cron: string): string {
  const [minF, hourF] = (cron || '').trim().split(/\s+/)
  const mm = parseInt(minF, 10)
  const hh = parseInt(hourF, 10)
  if (Number.isNaN(mm) || Number.isNaN(hh)) return '09:00'
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** Legacy 'hourly' ≡ cron '0 * * * *'; represent it as custom cron so the
 *  cadence UI (which has no Hourly preset) round-trips it losslessly. */
function normalizeSchedule(schedule: AgentDraft['schedule']): AgentDraft['schedule'] {
  if (schedule.type === 'hourly') return { ...schedule, type: 'cron', cron: schedule.cron || '0 * * * *' }
  return schedule
}

// Curated agent emojis — all ≤4 UTF-16 code units, so they fit the icon cap.
const AGENT_EMOJIS = [
  '🤖', '📊', '📈', '📉', '✉️', '📬', '🔔', '📅',
  '🗂️', '📝', '🔎', '🎯', '⚡', '🧠', '💬', '📣',
  '🛰️', '🧭', '🚀', '🛎️', '💼', '📌', '🧾', '🔗',
  '⏰', '🗓️', '✅', '⭐', '🔥', '💡', '🏷️', '🪄',
]

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-14 items-center justify-center rounded-md border border-input bg-background text-xl transition-colors hover:bg-accent"
        aria-label="Choose agent emoji"
      >
        {value || '🤖'}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-2 shadow-md">
          <div className="grid grid-cols-8 gap-0.5">
            {AGENT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onChange(emoji); setOpen(false) }}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded text-lg hover:bg-accent',
                  value === emoji && 'bg-accent',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentConfigForm({
  editingAgent,
  template,
  onSave,
  onRunAgent,
  runningId,
  onOpenRun,
  active = true,
  saveLabel,
}: {
  editingAgent?: any
  template?: any
  onSave: (draft: AgentDraft) => Promise<void> | void
  onRunAgent?: (agent: any) => Promise<void> | void
  runningId?: string | null
  /** Where a recent-run row should navigate; defaults to the dashboard deep link. */
  onOpenRun?: (runId: string) => void
  /** Dialogs pass their `open` flag so effects re-run each time they reopen. */
  active?: boolean
  saveLabel?: string
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [skillNames, setSkillNames] = useState<Record<string, string>>({})
  const [availableIntegrations, setAvailableIntegrations] = useState<AvailableIntegrations | null>(null)
  const [runs, setRuns] = useState<any[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  // Load this agent's recent runs when editing.
  useEffect(() => {
    if (!active || !editingAgent?.id) { setRuns([]); return }
    setRunsLoading(true)
    fetch(`/api/workflows/executions?agentId=${editingAgent.id}&limit=8`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => setRuns(Array.isArray(data.items) ? data.items.map((item: any) => item.execution) : []))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false))
  }, [active, editingAgent])

  // Load skill names for compact skills display
  useEffect(() => {
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          const map: Record<string, string> = {}
          for (const s of data.skills as SkillSummary[]) {
            map[s.id] = s.name
          }
          setSkillNames(map)
        }
      })
      .catch(() => {})
  }, [])

  // Load available integrations when the form becomes active
  useEffect(() => {
    if (!active) return
    fetch('/api/integrations/available')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setAvailableIntegrations({ tools: data.tools ?? [], connections: data.connections ?? [] })
        }
      })
      .catch(() => {})
  }, [active])

  useEffect(() => {
    const source = editingAgent || template
    setDraft(source ? {
      ...emptyDraft,
      ...source,
      instructions: source.instructions || source.objective || '',
      integrations: source.integrations || [],
      skills: source.skills || [],
      icon: source.icon || emptyDraft.icon,
      folder: source.folder || '',
      visibility: source.visibility || 'shared',
      schedule: normalizeSchedule({ ...emptyDraft.schedule, ...(source.schedule || {}) }),
    } : {
      ...emptyDraft,
      // When creating a fresh agent, default the schedule timezone to the
      // browser's resolved zone so daily/weekly times match the user's clock.
      schedule: { ...emptyDraft.schedule, timezone: browserTimezone() },
    })
  }, [editingAgent, active, template])

  const toggleIntegration = (label: string) => {
    const next = draft.integrations.includes(label)
      ? draft.integrations.filter((i) => i !== label)
      : [...draft.integrations, label]
    setDraft({ ...draft, integrations: next })
  }

  const detachSkill = (skillId: string) => {
    setDraft({ ...draft, skills: draft.skills.filter((id) => id !== skillId) })
  }

  const submit = async () => {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const openRun = (runId: string) => {
    if (onOpenRun) onOpenRun(runId)
    else router.push(`/dashboard?run=${runId}`)
  }

  // ── Schedule (cadence UI ↔ backend schedule) ──────────────────────────────
  const cadence = cadenceOf(draft.schedule)
  const scheduleTime = draft.schedule.type === 'cron'
    ? cronToTime(draft.schedule.cron || '')
    : (draft.schedule.time || '09:00')

  const setScheduleEnabled = (on: boolean) => {
    if (!on) {
      setDraft({ ...draft, schedule: { ...draft.schedule, type: 'manual', isActive: false } })
      return
    }
    // Turning it on from "manual" defaults to a daily cadence.
    const time = draft.schedule.time || '09:00'
    const timezone = draft.schedule.timezone || browserTimezone()
    const base = draft.schedule.type === 'manual'
      ? { type: 'daily' as const, time, timezone }
      : draft.schedule
    setDraft({ ...draft, schedule: { ...base, isActive: true } })
  }

  const setCadence = (next: Cadence) => {
    const time = scheduleTime
    const timezone = draft.schedule.timezone || browserTimezone()
    const schedule: AgentDraft['schedule'] =
      next === 'daily' ? { type: 'daily', time, timezone, isActive: true }
      : next === 'weekly' ? { type: 'weekly', time, timezone, isActive: true }
      : next === 'every_other_day' ? { type: 'cron', cron: everyOtherDayCron(time), time, timezone, isActive: true }
      : { type: 'cron', cron: draft.schedule.type === 'cron' ? (draft.schedule.cron || '0 9 * * 1-5') : '0 9 * * 1-5', timezone, isActive: true }
    setDraft({ ...draft, schedule })
  }

  const setScheduleTime = (time: string) => {
    setDraft({
      ...draft,
      schedule: cadence === 'every_other_day'
        ? { ...draft.schedule, time, cron: everyOtherDayCron(time) }
        : { ...draft.schedule, time },
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <Label>Name</Label>
        <div className="flex gap-2">
          <EmojiPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
          <Input className="flex-1" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </div>
      </div>
      <div>
        <Label>Description</Label>
        <Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Folder</Label>
          <Input
            placeholder="e.g. operations"
            value={draft.folder}
            onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
          />
        </div>
        <div>
          <Label>Visibility</Label>
          <Select value={draft.visibility} onValueChange={(visibility: AgentDraft['visibility']) => setDraft({ ...draft, visibility })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">Workspace</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Instructions</Label>
        <Textarea rows={8} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
      </div>
      <div>
        <Label>Model</Label>
        <Select value={draft.model} onValueChange={(model) => setDraft({ ...draft, model })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <ModelOption provider={m.provider} label={m.label} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Connected tools picker ───────────────────────────────────── */}
      <div>
        <Label>Connected tools</Label>
        {availableIntegrations ? (
          <div className="mt-2 space-y-3">
            {/* All configured/available tools across planes (built-ins, Nango,
                Klavis), deduped, with brand logos. */}
            {availableIntegrations.tools.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {availableIntegrations.tools.map((t) => {
                  const selected = draft.integrations.includes(t.key)
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggleIntegration(t.key)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <IntegrationLogo slug={t.slug} name={t.label} className="h-4 w-4 bg-white/70" />
                      {t.label}
                      {!t.connected && !selected && (
                        <span className="text-[10px] opacity-60">not configured</span>
                      )}
                      {t.connected && !selected && (
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            {/* Custom Backstory-MCP connections (loaded for every agent). */}
            {availableIntegrations.connections.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {availableIntegrations.connections.map((c) => {
                  const selected = draft.integrations.includes(c.name)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleIntegration(c.name)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      )}
                    >
                      <IntegrationLogo slug={c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')} name={c.name} className="h-4 w-4 bg-white/70" />
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Link
                href="/connections"
                className="text-xs font-medium text-primary hover:underline"
              >
                + Connect a tool
              </Link>
              <span className="text-xs text-muted-foreground">
                — add more in Connections.
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Loading integrations…</p>
        )}
      </div>

      {/* ── Schedule ─────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label>Schedule enabled</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Run this agent automatically on a cadence.</p>
          </div>
          <Switch checked={draft.schedule.isActive} onCheckedChange={setScheduleEnabled} />
        </div>

        {draft.schedule.isActive && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Cadence</Label>
                <Select value={cadence} onValueChange={(value) => setCadence(value as Cadence)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="every_other_day">Every other day</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="custom">Custom (cron)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {cadence !== 'custom' && (
                <div>
                  <Label>Time</Label>
                  <Input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} />
                </div>
              )}
            </div>

            {cadence !== 'custom' ? (
              <div>
                <Label>Timezone</Label>
                <Select
                  value={draft.schedule.timezone}
                  onValueChange={(timezone) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone } })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Keep a browser-detected zone outside the common list selectable. */}
                    {!COMMON_TIMEZONES.includes(draft.schedule.timezone as (typeof COMMON_TIMEZONES)[number]) && draft.schedule.timezone && (
                      <SelectItem value={draft.schedule.timezone}>{draft.schedule.timezone}</SelectItem>
                    )}
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {cadence === 'weekly' && (
                  <p className="mt-1 text-xs text-muted-foreground">Runs weekly at this time.</p>
                )}
              </div>
            ) : (
              <div>
                <Label>Cron expression</Label>
                <Input
                  placeholder="0 9 * * 1-5"
                  value={draft.schedule.cron || ''}
                  onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, type: 'cron', cron: event.target.value } })}
                />
                <p className="mt-1 text-xs text-muted-foreground">5-field cron, evaluated in {draft.schedule.timezone || 'UTC'}.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Compact Skills display ───────────────────────────────────── */}
      <div>
        <Label>Skills</Label>
        {draft.skills.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.skills.map((skillId) => (
              <span
                key={skillId}
                className="flex items-center gap-1 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground"
              >
                {skillNames[skillId] ?? skillId}
                <button
                  type="button"
                  aria-label={`Remove skill ${skillNames[skillId] ?? skillId}`}
                  onClick={() => detachSkill(skillId)}
                  className="ml-0.5 rounded-full p-0.5 transition-colors duration-150 hover:bg-border"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No skills attached.</p>
        )}
        <p className="mt-1.5 text-xs text-muted-foreground">
          Add skills from the{' '}
          <Link href="/templates" className="text-primary hover:underline">
            Templates page
          </Link>
          .
        </p>
      </div>

      {editingAgent && (
        <div>
          <p className="eyebrow mb-2">Recent runs</p>
          {runsLoading ? (
            <p className="text-sm text-gray-500"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-gray-500">No runs yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => openRun(run.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-gray-50"
                  >
                    <span className="truncate text-gray-700">{run.metadata?.headline || run.error || run.status}</span>
                    <span className="shrink-0 text-xs text-gray-500">{new Date(run.startedAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {editingAgent && onRunAgent && (
          <Button
            variant="outline"
            disabled={runningId === editingAgent.id}
            onClick={() => onRunAgent(editingAgent)}
            className="shrink-0"
          >
            {runningId === editingAgent.id
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Play className="mr-1.5 h-4 w-4" />}
            Run
          </Button>
        )}
        <Button className="flex-1" disabled={saving || !draft.title || !draft.instructions} onClick={submit}>
          {saving ? 'Saving...' : saveLabel || (editingAgent ? 'Save agent' : 'Create agent')}
        </Button>
      </div>
    </div>
  )
}
