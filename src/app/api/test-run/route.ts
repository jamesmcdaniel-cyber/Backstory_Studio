import { NextResponse } from 'next/server'
import { createModelRunner, type ToolDefinition, type ToolResult } from '@/lib/llm/model-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// TEMPORARY PROOF: runs the REAL execution engine (the same LLM loop + tool-calling
// that powers agent runs) against a STUB Backstory tool, to demonstrate the backend
// actually executes end-to-end. No DB/auth needed — pure engine + LLM. Remove after.
export async function GET() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' }, { status: 503 })
  }

  const tools: ToolDefinition[] = [
    {
      name: 'get_account_status',
      description: 'Get the current status of a Backstory account: open risks, next steps, engagement.',
      inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
    },
  ]

  // Canned data standing in for a real Backstory MCP tool response.
  const stub = (account: string) =>
    JSON.stringify({
      account,
      health: 'At risk',
      risks: ['Champion (VP Eng) went dark 12 days ago', 'Procurement stalled on MSA redlines'],
      nextSteps: ['Re-engage the economic buyer', 'Send revised MSA by Friday'],
      engagement: { lastMeeting: '2026-06-15', openOpportunities: 2, totalACV: 425000 },
    })

  const system =
    'You are a Backstory revenue-intelligence agent. When asked about an account, call get_account_status, then give a tight 2-3 sentence brief with the single top risk and the single best next step.'
  const input = "What's the status of the Acme Corp account? Give me the top risk and the next step."

  try {
    const runner = createModelRunner('claude-opus-4-8')
    const transcript = runner.start(input)
    const steps: Array<Record<string, unknown>> = []
    let final = ''
    for (let i = 0; i < 4; i++) {
      const turn = await runner.next(transcript, system, tools)
      if (turn.text) steps.push({ kind: 'model_text', text: turn.text })
      if (turn.toolCalls.length === 0) {
        final = turn.text
        break
      }
      const results: ToolResult[] = turn.toolCalls.map((c) => {
        const account = String((c.input as { account?: string }).account || 'Acme Corp')
        const out = stub(account)
        steps.push({ kind: 'tool_call', name: c.name, input: c.input })
        steps.push({ kind: 'tool_result', name: c.name, content: out })
        return { toolCallId: c.id, content: out }
      })
      runner.appendToolResults(transcript, results)
    }
    return NextResponse.json({ ok: true, input, steps, final })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) },
      { status: 500 },
    )
  }
}
