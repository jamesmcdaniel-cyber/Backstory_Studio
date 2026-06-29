import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Temporary diagnostic: surfaces the REAL database error.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true })
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
