/** A voice-huddle signaling message on the flow channel's 'huddle' bus event.
 *  join/leave are room-wide; offer/answer/ice are addressed via `to`. */
export type HuddleSignal = {
  kind: 'join' | 'leave' | 'offer' | 'answer' | 'ice'
  from: string
  to?: string
  sdp?: unknown
  candidate?: unknown
}

export type HuddleInstruction =
  | { action: 'create-offer'; peerId: string }
  | { action: 'apply-offer'; peerId: string; sdp: unknown }
  | { action: 'apply-answer'; peerId: string; sdp: unknown }
  | { action: 'add-ice'; peerId: string; candidate: unknown }
  | { action: 'close'; peerId: string }

/**
 * Pure signaling policy for the P2P mesh: EXISTING members initiate the offer
 * to a newcomer (one deterministic initiator per pair — no glare), targeted
 * messages apply only when addressed to us, own broadcasts are ignored. The
 * WebRTC side effects live in useFlowHuddle; this stays testable.
 */
export function reduceHuddleSignal(
  selfId: string,
  joined: boolean,
  peerIds: string[],
  signal: HuddleSignal,
): HuddleInstruction[] {
  if (signal.from === selfId) return []
  switch (signal.kind) {
    case 'join':
      return joined && !peerIds.includes(signal.from) ? [{ action: 'create-offer', peerId: signal.from }] : []
    case 'leave':
      return peerIds.includes(signal.from) ? [{ action: 'close', peerId: signal.from }] : []
    case 'offer':
      return joined && signal.to === selfId ? [{ action: 'apply-offer', peerId: signal.from, sdp: signal.sdp }] : []
    case 'answer':
      return joined && signal.to === selfId ? [{ action: 'apply-answer', peerId: signal.from, sdp: signal.sdp }] : []
    case 'ice':
      return joined && signal.to === selfId ? [{ action: 'add-ice', peerId: signal.from, candidate: signal.candidate }] : []
  }
}
