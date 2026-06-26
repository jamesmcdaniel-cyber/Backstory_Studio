'use client'

import { ReactNode } from 'react'
import { Sidebar } from './sidebar'
import { ErrorBoundary } from '@/components/ui/error-boundary'

interface DashboardLayoutProps {
  children: ReactNode
  fullscreen?: boolean
}

export function DashboardLayout({ children, fullscreen = false }: DashboardLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {fullscreen ? (
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        ) : (
          <div className="container mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-8">
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
          </div>
        )}
      </main>
    </div>
  )
}
