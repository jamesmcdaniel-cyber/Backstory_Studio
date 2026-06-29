/**
 * Granola REST API integration
 *
 * Exposes two agent tools — list_notes and get_note — that let agents
 * read the user's Granola meeting notes during a run.
 *
 * Requires: GRANOLA_API_KEY (format grn_…) in the environment.
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'

const GRANOLA_BASE_URL = 'https://public-api.granola.ai/v1'

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function granolaConfigured(): boolean {
  return Boolean(process.env.GRANOLA_API_KEY)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function granolaTools(): ToolDefinition[] {
  return [
    {
      name: 'list_notes',
      description:
        "List the user's recent Granola meeting notes (id, title, owner, AI summary). Optionally filter with created_after (ISO 8601 date) and paginate with cursor.",
      inputSchema: {
        type: 'object',
        properties: {
          created_after: { type: 'string' },
          cursor: { type: 'string' },
        },
      },
    },
    {
      name: 'get_note',
      description: "Get a Granola meeting note's full AI summary and transcript by id.",
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'Granola note id (not_...)' },
        },
        required: ['note_id'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// GranolaToolClient
// ---------------------------------------------------------------------------

export class GranolaToolClient {
  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // BackstoryMcpClient.executeTool (response.result), so the run loop's
  // JSON.stringify(result) wrapping is identical for both integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const apiKey = process.env.GRANOLA_API_KEY
    if (!apiKey) throw new Error('Granola API key is not configured')

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }

    let url: string

    if (name === 'list_notes') {
      const params = new URLSearchParams()
      if (typeof args.created_after === 'string' && args.created_after) {
        params.set('created_after', args.created_after)
      }
      if (typeof args.cursor === 'string' && args.cursor) {
        params.set('cursor', args.cursor)
      }
      const qs = params.toString()
      url = qs ? `${GRANOLA_BASE_URL}/notes?${qs}` : `${GRANOLA_BASE_URL}/notes`
    } else if (name === 'get_note') {
      const noteId = String(args.note_id ?? '')
      url = `${GRANOLA_BASE_URL}/notes/${encodeURIComponent(noteId)}?include=transcript`
    } else {
      throw new Error(`Unknown Granola tool: ${name}`)
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      throw new Error(`Granola API error ${response.status}`)
    }

    return response.json() as Promise<unknown>
  }
}
