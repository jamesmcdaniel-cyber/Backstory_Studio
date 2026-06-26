'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type AgentDraft = {
  title: string
  description: string
  instructions: string
  model: string
  priority: string
  integrations: string[]
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

const emptyDraft: AgentDraft = {
  title: '',
  description: '',
  instructions: '',
  model: 'claude-opus-4-8',
  priority: 'medium',
  integrations: [],
  icon: '🤖',
  folder: '',
  visibility: 'shared',
  schedule: { type: 'manual', timezone: 'UTC', isActive: false },
}

export function AgentConfigDialog({
  open,
  onOpenChange,
  onCreateAgent,
  editingAgent,
  template,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateAgent: (draft: AgentDraft) => Promise<void> | void
  editingAgent?: any
  template?: any
}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const source = editingAgent || template
    setDraft(source ? {
      ...emptyDraft,
      ...source,
      instructions: source.instructions || source.objective || '',
      integrations: source.integrations || [],
      icon: source.icon || emptyDraft.icon,
      folder: source.folder || '',
      visibility: source.visibility || 'shared',
      schedule: { ...emptyDraft.schedule, ...(source.schedule || {}) },
    } : emptyDraft)
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
          <Button className="w-full" disabled={saving || !draft.title || !draft.instructions} onClick={submit}>
            {saving ? 'Saving...' : editingAgent ? 'Save agent' : 'Create agent'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
