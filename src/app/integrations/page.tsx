'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Cable, Server } from 'lucide-react'
import { McpServersPanel } from '@/components/integrations/mcp-servers-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

type IntegrationsTab = 'integrations' | 'servers'

function tabFromParam(value: string | null): IntegrationsTab {
  if (value === 'servers') return 'servers'
  return 'integrations'
}

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = tabFromParam(searchParams.get('tab'))

  const handleTabChange = (value: string) => {
    const href = value === 'integrations' ? '/integrations' : `/integrations?tab=${value}`
    router.replace(href, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="integrations"><Cable className="mr-2 h-4 w-4" />Integrations</TabsTrigger>
        <TabsTrigger value="servers"><Server className="mr-2 h-4 w-4" />MCP Servers</TabsTrigger>
      </TabsList>
      <TabsContent value="integrations" className="mt-6 space-y-6">
        {/* Backstory Sales AI (MCP) connects on the MCP servers tab; Granola
            connects from the integrations grid below — both handled there, so
            no standalone cards here. */}
        <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
          <OAuthIntegrationsGrid />
        </Suspense>
      </TabsContent>
      <TabsContent value="servers" className="mt-6">
        <McpServersPanel returnTo="/integrations?tab=servers" />
      </TabsContent>
    </Tabs>
  )
}

export default function IntegrationsPage() {
  return (
    <>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Connections"
          title="Integrations"
          description="Connect your accounts with Nango or bring your own MCP servers."
        />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
