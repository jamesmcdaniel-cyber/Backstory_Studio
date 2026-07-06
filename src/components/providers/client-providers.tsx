'use client'

import { Toaster } from 'sonner'
import { MotionConfig } from 'motion/react'
import { SupabaseProvider } from './supabase-provider'

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SupabaseProvider>
        {children}
        <Toaster richColors />
      </SupabaseProvider>
    </MotionConfig>
  )
}
