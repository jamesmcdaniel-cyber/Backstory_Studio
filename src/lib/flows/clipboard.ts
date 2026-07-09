import { sanitizeCopiedNode } from '@/lib/flows/mutate'
import type { FlowNode } from '@/lib/flows/graph'

export const FLOW_CLIPBOARD_KEY = 'flows.clipboard.v1'

/** Persist a copied step (survives reloads and works across flows). */
export function writeFlowClipboard(node: FlowNode): void {
  try {
    localStorage.setItem(FLOW_CLIPBOARD_KEY, JSON.stringify(node))
  } catch {
    /* storage unavailable */
  }
  try {
    if (typeof navigator !== 'undefined') void navigator.clipboard?.writeText(JSON.stringify(node, null, 2))
  } catch {
    /* best-effort OS clipboard */
  }
}

/** Read + sanitize the copied step, or null. */
export function readFlowClipboard(): FlowNode | null {
  try {
    const raw = localStorage.getItem(FLOW_CLIPBOARD_KEY)
    if (!raw) return null
    return sanitizeCopiedNode(JSON.parse(raw))
  } catch {
    return null
  }
}
