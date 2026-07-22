'use client'

import { Toaster } from 'sonner'
import { MotionConfig } from 'motion/react'
import { SupabaseProvider } from './supabase-provider'
import { ProposalsProvider } from './proposals-provider'

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SupabaseProvider>
        <ProposalsProvider>
          {children}
        </ProposalsProvider>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                'rounded-lg border border-border bg-background text-foreground shadow-3 font-sans',
              description: 'text-muted-foreground',
              actionButton: 'bg-primary text-primary-foreground',
              cancelButton: 'bg-muted text-muted-foreground',
            },
          }}
        />
      </SupabaseProvider>
    </MotionConfig>
  )
}
