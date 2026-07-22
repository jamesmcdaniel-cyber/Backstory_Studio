import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'

// Public (unauthenticated) preview of an invitation by token, so the /invite
// page can greet the recipient with the workspace name before they sign in.
// Reveals only the org name, invited email, and role — nothing more.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ valid: false }, { status: 400 })
  try {
    const invite = await prisma.invitation.findFirst({
      where: { tokenHash: hashToken(token), status: 'PENDING', expiresAt: { gt: new Date() } },
      select: { email: true, role: true, organization: { select: { name: true } } },
    })
    if (!invite) return NextResponse.json({ valid: false })
    return NextResponse.json({
      valid: true,
      email: invite.email,
      role: invite.role,
      organizationName: invite.organization?.name ?? 'a workspace',
    })
  } catch {
    return NextResponse.json({ valid: false }, { status: 500 })
  }
}
