'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'

type Template = {
  id: string
  name: string
  description: string
  instructions: string
  integrations: string[]
  skills?: string[]
  model: string
  exampleOutput?: string
  icon?: string
  allowSubagents?: boolean
  // Set on templates that provision a complete multi-step Flow (agents + graph).
  playbook?: string
}

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [creating, setCreating] = useState(false)
  const [deploying, setDeploying] = useState(false)

  useEffect(() => {
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setTemplate((data.templates || []).find((item: Template) => item.id === id) || null))
  }, [id])

  const createAgent = async () => {
    if (!template) return
    setCreating(true)
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: template.name,
        description: template.description,
        instructions: template.instructions,
        integrations: template.integrations,
        skills: template.skills || [],
        model: template.model,
        icon: template.icon || '',
        allowSubagents: template.allowSubagents === true,
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      }),
    })
    setCreating(false)
    if (response.ok) router.push('/dashboard')
  }

  // Playbook templates provision the full motion: agents + a wired Flow.
  const deployPlaybook = async () => {
    if (!template?.playbook) return
    setDeploying(true)
    const response = await fetch(`/api/playbooks/${template.playbook}`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    setDeploying(false)
    if (response.ok && data.flowId) router.push(`/flows/${data.flowId}`)
  }

  return (
    <>
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {!template ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-2/3 rounded-lg" />
            <Skeleton className="h-5 w-full rounded" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : (
          <>
            <div className="flex animate-fade-in-up items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{template.name}</h1>
                <p className="mt-2 text-gray-600">{template.description}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {template.playbook && (
                  <Button onClick={deployPlaybook} loading={deploying}>
                    {deploying ? 'Deploying…' : 'Deploy as Flow'}
                  </Button>
                )}
                <Button variant={template.playbook ? 'outline' : 'default'} onClick={createAgent} loading={creating}>
                  {creating ? 'Creating…' : 'Use template'}
                </Button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap rounded-lg border bg-gray-50 p-4 text-sm shadow-1">{template.instructions}</pre>

            {template.exampleOutput && (
              <div>
                <p className="eyebrow mb-2">Example output</p>
                <div className="rounded-lg border border-horizon-200 bg-horizon-50/40 p-4 shadow-1">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{template.exampleOutput}</p>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">Illustrative — actual output uses your live data.</p>
              </div>
            )}

            {template.integrations.length > 0 && (
              <div>
                <p className="eyebrow mb-2">Requires</p>
                <div className="flex flex-wrap gap-2">
                  {template.integrations.map((integration) => <IntegrationChip key={integration} name={integration} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
