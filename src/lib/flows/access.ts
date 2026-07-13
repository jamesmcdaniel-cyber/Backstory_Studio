import { ApiError } from '@/lib/server/api-handler'

/**
 * Flow share roles (workbooks parity, v1): `visibility` gains 'view'.
 *   'shared'  — everyone in the org can see, run, and edit (the default).
 *   'view'    — everyone can see and run; only the OWNER edits/publishes.
 *   'private' — only the owner sees it at all (existing behavior).
 * Reads stay governed by agentVisibilityScope ('view' is visible because it
 * is not 'private'); WRITES call this guard.
 */

export function canEditFlow(flow: { visibility: string; userId: string | null }, userId: string): boolean {
  if (flow.visibility !== 'view') return true
  // Legacy ownerless rows stay editable by the org rather than by no one.
  return flow.userId === null || flow.userId === userId
}

export function assertFlowEditable(flow: { visibility: string; userId: string | null }, userId: string): void {
  if (canEditFlow(flow, userId)) return
  throw new ApiError('This flow is view-only — ask its owner to make changes.', 403, 'FLOW_VIEW_ONLY')
}
