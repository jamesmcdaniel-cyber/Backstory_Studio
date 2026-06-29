import { NextResponse } from 'next/server'
import { createModelRunner, type ToolDefinition, type ToolResult } from '@/lib/llm/model-runner'
import { BackstoryMcpClient, backstoryMcpConfigured } from '@/lib/mcp/backstory-mcp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// TEMPORARY PROOF: runs the REAL execution engine against the REAL Backstory MCP
// (live client-credentials → mcp.backstory.ai). Pass ?account=NAME to look up a
// real account. No DB/auth needed. Remove after demonstrating.
export async function GET(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' }, { status: 503 })
  if (!backstoryMcpConfigured()) return NextResponse.json({ ok: false, error: 'Backstory MCP not configured' }, { status: 503 })

  const url = process.env.BACKSTORY_MCP_URL as string
  const account = new URL(request.url).searchParams.get('account') || 'Acme'
  const client = new BackstoryMcpClient()

  try {
    const available = await client.getServerTools(url)
    const tools: ToolDefinition[] = available.slice(0, 20).map((t) => ({
      name: t.name,
      description: t.description || t.name,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))

    const system =
      'You are a Backstory revenue-intelligence agent with LIVE Backstory tools. When asked about an account, find it and report a tight brief: health, the single top risk, and the single best next step. If the account is not found, say so plainly.'
    const input = `Look up the account "${account}" in Backstory and give me its status — top risk and next step.`

    const runner = createModelRunner('claude-opus-4-8')
    const transcript = runner.start(input)
    const steps: Array<Record<string, unknown>> = []
    let final = ''
    for (let i = 0; i < 6; i++) {
      const turn = await runner.next(transcript, system, tools)
      if (turn.text) steps.push({ kind: 'model_text', text: turn.text })
      if (turn.toolCalls.length === 0) { final = turn.text; break }
      const results: ToolResult[] = []
      for (const c of turn.toolCalls) {
        steps.push({ kind: 'tool_call', name: c.name, input: c.input })
        try {
          const out = await client.executeTool(url, c.name, c.input)
          const content = typeof out === 'string' ? out : JSON.stringify(out)
          steps.push({ kind: 'tool_result', name: c.name, content: content.slice(0, 600) })
          results.push({ toolCallId: c.id, content })
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 200) : String(e)
          steps.push({ kind: 'tool_error', name: c.name, error: msg })
          results.push({ toolCallId: c.id, content: `Error: ${msg}`, isError: true })
        }
      }
      runner.appendToolResults(transcript, results)
    }
    return NextResponse.json({ ok: true, backstoryConfigured: true, toolCount: available.length, toolNames: available.map((t) => t.name), account, steps, final })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) }, { status: 500 })
  }
}
