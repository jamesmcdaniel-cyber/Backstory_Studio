'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Stale-while-revalidate JSON fetch with a process-wide client cache.
 *
 * The app fetches with raw `fetch` + `useState`, so every component starts empty
 * and refetches on mount — and because each top-level page renders its own
 * layout, navigating remounts everything, flashing empty/old UI until the
 * refetch lands. This hook caches responses by URL for the lifetime of the tab:
 * a remount paints the cached value INSTANTLY (no flash), then revalidates in
 * the background. Concurrent callers for the same URL share one in-flight
 * request. Endpoints stay `no-store` at the network layer; this is purely a
 * client-memory cache, so it never serves cross-user or persisted-stale data.
 */

type Entry = { data: unknown; ts: number }
const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string })?.error || `Request failed (${res.status})`)
  return body
}

export function useCachedJson<T = unknown>(url: string | null) {
  const [data, setData] = useState<T | undefined>(() => (url ? (store.get(url)?.data as T | undefined) : undefined))
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(() => (url ? !store.has(url) : false))

  const refresh = useCallback(async () => {
    if (!url) return
    let pending = inflight.get(url)
    if (!pending) {
      pending = fetchJson(url)
      inflight.set(url, pending)
    }
    try {
      const result = await pending
      store.set(url, { data: result, ts: Date.now() })
      setData(result as T)
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      inflight.delete(url)
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    if (!url) return
    const hit = store.get(url)
    if (hit) {
      setData(hit.data as T)
      setLoading(false)
    }
    void refresh()
  }, [url, refresh])

  // Optimistically overwrite the cached value (e.g. after a local mutation).
  const mutate = useCallback(
    (next: T) => {
      if (url) store.set(url, { data: next, ts: Date.now() })
      setData(next)
    },
    [url],
  )

  return { data, loading, error, refresh, mutate }
}

/** Drop a URL's cached entry so the next mount/refresh refetches from the server. */
export function invalidateCachedJson(url: string): void {
  store.delete(url)
}
