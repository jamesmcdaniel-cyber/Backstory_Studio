import { ApiError } from '@/lib/server/api-handler'

// Converts a Pipedream SDK / config failure into a clear ApiError instead of a
// generic 500.
export function pipedreamApiError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error)
  if (/not configured/i.test(message)) {
    return new ApiError('Pipedream is not configured for this environment.', 503, 'PIPEDREAM_UNAVAILABLE')
  }
  const status = (error as any)?.statusCode ?? (error as any)?.status
  if (status === 401 || status === 403) {
    return new ApiError('Pipedream credentials are invalid or unauthorized.', 502, 'PIPEDREAM_UNAUTHORIZED')
  }
  return new ApiError(`Pipedream request failed: ${message.slice(0, 160)}`, 502, 'PIPEDREAM_ERROR')
}
