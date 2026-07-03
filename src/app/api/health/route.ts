import { NextResponse } from 'next/server'
import { cachePing } from '@/lib/cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // Round-trip the cache so you can verify Redis is actually wired:
  // cache.configured=true + cache.ok=true → Redis live; configured=true +
  // ok=false → REDIS_URL set but unreachable; configured=false → in-memory.
  const cache = await cachePing()
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString(), cache })
}
