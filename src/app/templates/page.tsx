'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

interface SkillItem {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

interface AgentItem {
  id: string
  title: string
  skills: string[]
}

function ExplorePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = searchParams.get('tab') === 'skills' ? 'skills' : 'templates'

  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Track which skill's dropdown is open
  const [openSkillMenu, setOpenSkillMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const handleTabChange = (value: string) => {
    router.replace(value === 'skills' ? '/templates?tab=skills' : '/templates', { scroll: false })
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [templatesRes, skillsRes, agentsRes] = await Promise.all([
          fetch('/api/agent-templates', { cache: 'no-store' }),
          fetch('/api/skills', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
        ])
        if (!templatesRes.ok) throw new Error(`Templates fetch failed: status ${templatesRes.status}`)
        const [templatesData, skillsData, agentsData] = await Promise.all([
          templatesRes.json(),
          skillsRes.ok ? skillsRes.json() : { success: false, skills: [] },
          agentsRes.ok ? agentsRes.json() : { success: false, agents: [] },
        ])
        if (cancelled) return
        setTemplates(templatesData.templates || [])
        setSkills(skillsData.success ? skillsData.skills : [])
        setAgents(agentsData.success ? agentsData.agents : [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load templates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!openSkillMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenSkillMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openSkillMenu])

  const addSkillToAgent = async (skill: SkillItem, agent: AgentItem) => {
    setOpenSkillMenu(null)
    const updatedSkills = Array.from(new Set([...(agent.skills || []), skill.id]))
    try {
      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, skills: updatedSkills }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      // Update local agent list so subsequent "add" operations see the latest skills
      setAgents((prev) =>
        prev.map((a) => a.id === agent.id ? { ...a, skills: updatedSkills } : a)
      )
      toast.success(`Added "${skill.name}" to ${agent.title}`)
    } catch {
      toast.error(`Failed to add skill to ${agent.title}`)
    }
  }

  if (loading || error) {
    return (
      <DashboardLayout>
        <div className="max-w-6xl mx-auto p-6">
          <h1 className="text-2xl font-bold mb-4">Explore</h1>
          {loading && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-red-500">{error}</p>}
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-bold">Explore</h1>

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
          </TabsList>

          {/* ── Templates tab ─────────────────────────────────────────────── */}
          <TabsContent value="templates" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Templates</h2>
              <p className="text-sm text-muted-foreground">Single-task and enhanced templates</p>
            </div>

            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No templates available yet.</p>
            ) : (
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
                        <p className="text-sm text-muted-foreground line-clamp-3">{t.description}</p>
                        {t.integrations && t.integrations.length > 0 && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Requires</p>
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
            )}
          </TabsContent>

          {/* ── Skills tab ────────────────────────────────────────────────── */}
          <TabsContent value="skills" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Skills</h2>
              <p className="text-sm text-muted-foreground">Instruction packs that extend agents at run time</p>
            </div>

            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No skills available yet.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {skills.map((skill) => (
                  <Card key={skill.id} className="h-full flex flex-col">
                    <CardHeader className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base leading-snug">{skill.name}</CardTitle>
                        <Badge variant="secondary" className="shrink-0 text-xs">{skill.category}</Badge>
                      </div>
                      {skill.tags && skill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1 space-y-3">
                      <p className="text-sm text-muted-foreground line-clamp-3 flex-1">{skill.description}</p>

                      {/* Add to agent control */}
                      <div className="relative" ref={openSkillMenu === skill.id ? menuRef : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            if (agents.length === 0) {
                              toast('Create an agent first before adding skills.')
                              return
                            }
                            setOpenSkillMenu(openSkillMenu === skill.id ? null : skill.id)
                          }}
                        >
                          Add to agent
                        </Button>

                        {openSkillMenu === skill.id && agents.length > 0 && (
                          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-md border border-border bg-popover shadow-md">
                            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground font-medium">Select an agent</p>
                            <ul className="max-h-48 overflow-y-auto pb-1">
                              {agents.map((agent) => (
                                <li key={agent.id}>
                                  <button
                                    type="button"
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                                    onClick={() => addSkillToAgent(skill, agent)}
                                  >
                                    {agent.title}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}

export default function TemplatesIndexPage() {
  return (
    <Suspense fallback={null}>
      <ExplorePage />
    </Suspense>
  )
}
