'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

type Template = {
  id: string
  name: string
  description: string
  instructions: string
  integrations: string[]
  model: string
}

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [creating, setCreating] = useState(false)

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
        model: template.model,
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      }),
    })
    setCreating(false)
    if (response.ok) router.push('/dashboard')
  }

  return (
    <>
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {!template ? <p className="text-sm text-gray-500">Loading template...</p> : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{template.name}</h1>
                <p className="mt-2 text-gray-600">{template.description}</p>
              </div>
              <Button onClick={createAgent} disabled={creating}>{creating ? 'Creating...' : 'Use template'}</Button>
            </div>
            <pre className="whitespace-pre-wrap rounded-lg border bg-gray-50 p-4 text-sm">{template.instructions}</pre>
            <div className="flex flex-wrap gap-2">
              {template.integrations.map((integration) => <Badge key={integration} variant="outline">{integration}</Badge>)}
            </div>
          </>
        )}
      </div>
    </>
  )
}
