export type NotificationLinkFields = {
  type: string
  executionId?: string | null
  link?: string | null
}

/**
 * In-app destination for a notification. A persisted `link` (e.g. a jam
 * invite's /flows/<id>) always wins; flow notifications without one carry the
 * FLOW id in executionId and deep-link to that flow's activity page — a flow
 * run id is not resolvable by the dashboard.
 */
export function notificationHref(n: NotificationLinkFields): string {
  if (n.link) return n.link
  if (n.type.startsWith('flow.') && n.executionId) return `/flows/${n.executionId}/activity`
  return n.executionId ? `/agents?run=${n.executionId}` : '/dashboard'
}
