'use client'

import { Toaster } from 'sonner'
import { SupabaseProvider } from './supabase-provider'

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <SupabaseProvider>
      {children}
      <Toaster richColors />
    </SupabaseProvider>
  )
}
