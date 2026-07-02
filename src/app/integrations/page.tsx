'use client'

import { Suspense } from 'react'
import { Bot, Cable } from 'lucide-react'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { MCPIntegrationCards } from '@/components/integrations/mcp-integration-cards'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GranolaCard } from './granola-card'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

export default function IntegrationsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-gray-500">Klavis exposes agent tools. Nango manages connected accounts.</p>
        </div>
        <Tabs defaultValue="tools">
          <TabsList>
            <TabsTrigger value="tools"><Bot className="mr-2 h-4 w-4" />Agent tools</TabsTrigger>
            <TabsTrigger value="accounts"><Cable className="mr-2 h-4 w-4" />Connected accounts</TabsTrigger>
          </TabsList>
          <TabsContent value="tools" className="mt-6"><MCPIntegrationCards /></TabsContent>
          <TabsContent value="accounts" className="mt-6 space-y-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <GranolaCard />
            </div>
            <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
              <OAuthIntegrationsGrid />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
