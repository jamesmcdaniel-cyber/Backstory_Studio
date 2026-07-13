'use client'

import { useEffect, useState } from 'react'
import type { TriggerInputField } from '@/lib/flows/graph'

export type WorkspaceFlow = {
  id: string
  name: string
  published: boolean
  /** The child's declared trigger input fields — what a subflow step can map. */
  inputFields: TriggerInputField[]
}

/**
 * The workspace's flows, for pickers that reference OTHER flows (the subflow
 * step's flow select). Fetched once per mount; failures degrade to an empty
 * list (the editor shows its own guidance when nothing is selectable).
 */
export function useWorkspaceFlows(): { flows: WorkspaceFlow[]; loading: boolean } {
  const [flows, setFlows] = useState<WorkspaceFlow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    fetch('/api/flows')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!alive || !data?.success) return
        const rows = (data.flows ?? []) as {
          id: string
          name: string
          published?: boolean
          publishedGraph?: unknown
          trigger?: { inputFields?: TriggerInputField[] }
        }[]
        setFlows(
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            published: Boolean(row.published ?? row.publishedGraph != null),
            inputFields: row.trigger?.inputFields ?? [],
          })),
        )
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])
  return { flows, loading }
}
