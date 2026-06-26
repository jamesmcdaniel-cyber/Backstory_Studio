import { PipedreamClient, ProjectEnvironment } from '@pipedream/sdk'

/**
 * Creates a configured Pipedream client using env vars.
 * Required env vars:
 *  - PIPEDREAM_CLIENT_ID
 *  - PIPEDREAM_CLIENT_SECRET
 *  - PIPEDREAM_PROJECT_ID
 *  - PIPEDREAM_PROJECT_ENVIRONMENT (development|production) [optional, defaults to production]
 */
export function getPipedreamClient() {
  const clientId = process.env.PIPEDREAM_CLIENT_ID
  const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET
  const projectId = process.env.PIPEDREAM_PROJECT_ID
  const projectEnvironment = (process.env.PIPEDREAM_PROJECT_ENVIRONMENT || 'production').toLowerCase()

  if (!clientId || !clientSecret || !projectId) {
    throw new Error('Pipedream is not configured. Please set PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, and PIPEDREAM_PROJECT_ID')
  }

  const env = projectEnvironment === 'development'
    ? ProjectEnvironment.Development
    : ProjectEnvironment.Production

  return new PipedreamClient({
    clientId,
    clientSecret,
    projectId,
    projectEnvironment: env,
  })
}
