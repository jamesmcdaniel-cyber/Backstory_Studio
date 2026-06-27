import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { apiLogger } from '@/lib/logger'
import { composeInstructions } from '@/lib/skills/compose'

export const runtime = 'nodejs'

function secretsMatch(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// External trigger for agents (webhooks, API calls, Pipedream event sources).
// Authenticated by the per-agent secret instead of a Supabase session.
export async function POST(request: NextRequest) {
  try {
    if (!workersEnabled) {
      return NextResponse.json({ success: false, error: 'Agent worker is disabled' }, { status: 503 })
    }
    const id = request.nextUrl.pathname.split('/').at(-2)
    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) {
      return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })
    }

    const agent = await prisma.agentTask.findFirst({ where: { id, status: 'ACTIVE' } })
    const metadata = agent?.metadata && typeof agent.metadata === 'object' ? agent.metadata as Record<string, unknown> : {}
    const secret = typeof metadata.triggerSecret === 'string' ? metadata.triggerSecret : null
    if (!agent || !secret || !secretsMatch(provided, secret)) {
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({})) as { input?: unknown }
    const skillIds: string[] = Array.isArray(metadata.skills) ? (metadata.skills as string[]) : []
    const objectiveWithSkills = composeInstructions(agent.objective, skillIds)
    const input = typeof body.input === 'string' && body.input.trim() ? body.input.trim() : objectiveWithSkills

    const user = await prisma.user.findFirst({
      where: { organizationId: agent.organizationId, isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!user) {
      return NextResponse.json({ success: false, error: 'No active user in organization' }, { status: 409 })
    }

    const execution = await prisma.agentExecution.create({
      data: {
        agentType: agent.agentType,
        agentTaskId: agent.id,
        status: 'pending',
        input: { prompt: input },
        trigger: { type: 'webhook' },
        metadata: { title: (metadata.title as string) || agent.description },
        userId: user.id,
        organizationId: agent.organizationId,
      },
    })

    const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
    await queue.add('execute-agent', {
      executionId: execution.id,
      agentId: agent.id,
      organizationId: agent.organizationId,
      userId: user.id,
      input,
    }, { jobId: execution.id })

    return NextResponse.json({ success: true, executionId: execution.id, status: 'pending' })
  } catch (error) {
    apiLogger.error('Agent trigger failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
