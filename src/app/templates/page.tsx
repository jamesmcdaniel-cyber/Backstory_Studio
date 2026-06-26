'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DashboardLayout } from '@/components/layout/dashboard-layout'

interface TemplateItem {
  id: string
  name: string
  description: string
  category: string
  integrations?: string[]
  tags?: string[]
  version?: string
}

export default function TemplatesIndexPage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/agent-templates', { cache: 'no-store' })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setTemplates(data.templates || [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load templates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading || error) {
    return (
      <DashboardLayout>
        <div className="max-w-6xl mx-auto p-6">
          <h1 className="text-2xl font-bold mb-4">Templates</h1>
          {loading && <p className="text-gray-600">Loading templates…</p>}
          {error && <p className="text-red-600">{error}</p>}
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Templates</h1>
          <p className="text-sm text-gray-500">Single-task and enhanced templates</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.map((t) => (
            <Link key={t.id} href={`/templates/${t.id}`} className="block">
              <Card className="h-full hover:shadow-md transition-shadow">
                <CardHeader className="space-y-2">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-lg">{t.name}</CardTitle>
                    <Badge variant="secondary">{t.category}</Badge>
                  </div>
                  {t.tags && t.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {t.tags.slice(0, 3).map(tag => (
                        <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-gray-700 line-clamp-3">{t.description}</p>
                  {t.integrations && t.integrations.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Requires</p>
                      <div className="flex flex-wrap gap-1">
                        {t.integrations.map((i) => (
                          <Badge key={i} variant="outline" className="text-xs">{i}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
