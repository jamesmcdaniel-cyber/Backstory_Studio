import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { AuthContextError, requireAuthContext, type AuthContext } from './auth'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BAD_REQUEST',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type AuthenticatedHandler = (
  request: NextRequest,
  auth: AuthContext,
) => Promise<Response | Record<string, unknown>>

export function withAuthenticatedApi(handler: AuthenticatedHandler) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const auth = await requireAuthContext()
      const result = await handler(request, auth)

      return result instanceof Response ? result : NextResponse.json(result)
    } catch (error) {
      if (error instanceof AuthContextError) {
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
        )
      }

      if (error instanceof ApiError) {
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
        )
      }

      if (error instanceof ZodError) {
        return NextResponse.json(
          { success: false, error: 'Invalid request', code: 'VALIDATION_ERROR', issues: error.issues },
          { status: 400 },
        )
      }

      apiLogger.error('API request failed', {
        path: request.nextUrl.pathname,
        error: error instanceof Error ? error.message : String(error),
      })
      captureError(error, { path: request.nextUrl.pathname })

      return NextResponse.json(
        { success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      )
    }
  }
}
