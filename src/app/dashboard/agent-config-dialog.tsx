'use client'

import { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type SkillSummary = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

type AgentDraft = {
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
  model: 'claude-opus-4-8',
  priority: 'medium',
  integrations: [],
  skills: [],
  icon: '🤖',
  folder: '',
  visibility: 'shared',
  schedule: { type: 'manual', time: '09:00', timezone: 'UTC', isActive: false },
}

export function AgentConfigDialog({
  open,
  onOpenChange,
  onCreateAgent,
  onRunAgent,
  editingAgent,
  template,
  runningId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateAgent: (draft: AgentDraft) => Promise<void> | void
  onRunAgent?: (agent: any) => Promise<void> | void
  editingAgent?: any
  template?: any
  runningId?: string | null
}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([])

  useEffect(() => {
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => { if (data.success) setAvailableSkills(data.skills) })
      .catch(() => {})
  }, [])

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
      schedule: { ...emptyDraft.schedule, ...(source.schedule || {}) },
    } : {
      ...emptyDraft,
      // When creating a fresh agent, default the schedule timezone to the
      // browser's resolved zone so daily/weekly times match the user's clock.
      schedule: { ...emptyDraft.schedule, timezone: browserTimezone() },
    })
  }, [editingAgent, open, template])

  const submit = async () => {
    setSaving(true)
    try {
      await onCreateAgent(draft)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editingAgent ? 'Edit agent' : 'New agent'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <div className="flex gap-2">
              <Input
                className="w-16 text-center text-lg"
                value={draft.icon}
                onChange={(event) => setDraft({ ...draft, icon: event.target.value.slice(0, 8) })}
                aria-label="Agent icon"
              />
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Model</Label>
              <Select value={draft.model} onValueChange={(model) => setDraft({ ...draft, model })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-opus-4-8">Claude Opus 4.8</SelectItem>
                  <SelectItem value="claude-sonnet-4-6">Claude Sonnet 4.6</SelectItem>
                  <SelectItem value="claude-haiku-4-5">Claude Haiku 4.5</SelectItem>
                  <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o mini</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Schedule</Label>
              <Select value={draft.schedule.type} onValueChange={(type: AgentDraft['schedule']['type']) => setDraft({
                ...draft,
                schedule: { ...draft.schedule, type, isActive: type !== 'manual' },
              })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="cron">Custom (cron)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {(draft.schedule.type === 'daily' || draft.schedule.type === 'weekly') && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Time</Label>
                <Input
                  type="time"
                  value={draft.schedule.time || '09:00'}
                  onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })}
                />
              </div>
              <div>
                <Label>Timezone</Label>
                <Select
                  value={draft.schedule.timezone}
                  onValueChange={(timezone) => setDraft({ ...draft, schedule: { ...draft.schedule, timezone } })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {/* Include the current zone first if it isn't one of the common ones,
                        so a browser-detected zone outside the list still renders selected. */}
                    {!COMMON_TIMEZONES.includes(draft.schedule.timezone as (typeof COMMON_TIMEZONES)[number]) && draft.schedule.timezone && (
                      <SelectItem value={draft.schedule.timezone}>{draft.schedule.timezone}</SelectItem>
                    )}
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {draft.schedule.type === 'cron' && (
            <div>
              <Label>Cron expression</Label>
              <Input
                placeholder="0 9 * * 1-5"
                value={draft.schedule.cron || ''}
                onChange={(event) => setDraft({ ...draft, schedule: { ...draft.schedule, cron: event.target.value } })}
              />
            </div>
          )}
          <div>
            <Label>Connected tools</Label>
            <Input
              placeholder="slack, github, linear"
              value={draft.integrations.join(', ')}
              onChange={(event) => setDraft({
                ...draft,
                integrations: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
              })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label>Schedule enabled</Label>
            <Switch
              checked={draft.schedule.isActive}
              onCheckedChange={(isActive) => setDraft({ ...draft, schedule: { ...draft.schedule, isActive } })}
            />
          </div>
          {availableSkills.length > 0 && (
            <div>
              <Label>Skills</Label>
              <p className="text-xs text-muted-foreground mb-2">Attach instruction packs that extend this agent at run time.</p>
              <div className="flex flex-wrap gap-2">
                {availableSkills.map((skill) => {
                  const selected = draft.skills.includes(skill.id)
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      title={skill.description}
                      onClick={() => {
                        const next = selected
                          ? draft.skills.filter((id) => id !== skill.id)
                          : [...draft.skills, skill.id]
                        setDraft({ ...draft, skills: next })
                      }}
                      className={[
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                      ].join(' ')}
                    >
                      {skill.name}
                    </button>
                  )
                })}
              </div>
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
              {saving ? 'Saving...' : editingAgent ? 'Save agent' : 'Create agent'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
