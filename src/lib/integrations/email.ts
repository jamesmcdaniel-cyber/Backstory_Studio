/**
 * Email integration via Resend REST API
 *
 * Exposes one agent tool — send — that lets agents send emails during a run.
 *
 * Requires: RESEND_API_KEY in the environment.
 * Optional: EMAIL_FROM (defaults to "Backstory <onboarding@resend.dev>").
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'

const RESEND_API_URL = 'https://api.resend.com/emails'

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function emailTools(): ToolDefinition[] {
  return [
    {
      name: 'send',
      description: 'Send an email to one recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'plain-text body' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// EmailToolClient
// ---------------------------------------------------------------------------

export class EmailToolClient {
  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // GranolaToolClient.executeTool, so the run loop's JSON.stringify(result)
  // wrapping is identical for all integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) throw new Error('Resend API key is not configured')

    if (name === 'send') {
      const from = process.env.EMAIL_FROM || 'Backstory <onboarding@resend.dev>'

      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [args.to],
          subject: args.subject,
          text: args.body,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        throw new Error(`Email API error ${response.status}`)
      }

      return response.json() as Promise<unknown>
    }

    throw new Error(`Unknown Email tool: ${name}`)
  }
}
