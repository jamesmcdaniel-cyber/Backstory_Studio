import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Temporary diagnostic: surfaces the REAL database error (connection vs
// missing-table vs auth) instead of the generic 500 the app otherwise returns.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
    let agentTaskCount: number | string = 'n/a'
    let mcpConnectionCount: number | string = 'n/a'
    try {
      agentTaskCount = await prisma.agentTask.count()
    } catch (e) {
      agentTaskCount = `ERR: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`
    }
    try {
      mcpConnectionCount = await prisma.mcpConnection.count()
    } catch (e) {
      mcpConnectionCount = `ERR: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`
    }
    return NextResponse.json({ ok: true, select1: true, agentTaskCount, mcpConnectionCount })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        name: error instanceof Error ? error.name : 'Unknown',
        code: (error as { code?: string })?.code,
        error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      },
      { status: 503 },
    )
  }
}
