'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

const supabase = createClient()

/** The canonical app origin for auth redirects: the configured production URL
 *  when set (so links never point at localhost/preview), else the live origin. */
function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  return typeof window !== 'undefined' ? window.location.origin : ''
}

type SupabaseContext = {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => ReturnType<typeof supabase.auth.signInWithPassword>
  signUp: (email: string, password: string, options?: { data?: Record<string, unknown> }) => ReturnType<typeof supabase.auth.signUp>
  signOut: () => Promise<void>
}

const Context = createContext<SupabaseContext | null>(null)

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const value = useMemo<SupabaseContext>(() => ({
    user,
    loading,
    signIn: (email, password) => supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    }),
    signUp: (email, password, options) => supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: options?.data,
        // Prefer the configured production URL so confirmation links never point
        // at localhost or a preview origin; fall back to the current origin.
        emailRedirectTo: `${appOrigin()}/auth/callback`,
      },
    }),
    signOut: async () => {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    },
  }), [loading, user])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSupabase() {
  const context = useContext(Context)
  if (!context) throw new Error('useSupabase must be used within SupabaseProvider')
  return context
}
