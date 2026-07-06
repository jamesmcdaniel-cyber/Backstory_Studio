'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Bot, Cable } from 'lucide-react'
import { MCPIntegrationCards } from '@/components/integrations/mcp-integration-cards'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GranolaCard } from './granola-card'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = searchParams.get('tab') === 'accounts' ? 'accounts' : 'tools'

  const handleTabChange = (value: string) => {
    router.replace(value === 'accounts' ? '/integrations?tab=accounts' : '/integrations', { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="tools"><Bot className="mr-2 h-4 w-4" />Agent tools</TabsTrigger>
        <TabsTrigger value="accounts"><Cable className="mr-2 h-4 w-4" />Connected accounts</TabsTrigger>
      </TabsList>
      <TabsContent value="tools" className="mt-6"><MCPIntegrationCards /></TabsContent>
      <TabsContent value="accounts" className="mt-6 space-y-6">
        {/* Backstory Sales AI (MCP) connects on the MCP Servers page — its
            OAuth/DCR flow through the generic dialog is the canonical path. */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <GranolaCard />
        </div>
        <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
          <OAuthIntegrationsGrid />
        </Suspense>
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
          description="Klavis exposes agent tools. Nango manages connected accounts."
        />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
