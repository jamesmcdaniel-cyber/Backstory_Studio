import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Organizations the user belongs to. Membership is single-org today; the
// shape is a list so the org switcher works unchanged when multi-org lands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true, slug: true, plan: true },
  })
  return {
    success: true,
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [organization] : [],
  }
})
