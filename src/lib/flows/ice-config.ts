export type IceServer = { urls: string | string[]; username?: string; credential?: string }

/**
 * WebRTC ICE servers from env. Always Google STUN; a TURN relay entry is
 * appended only when ALL of TURN_URL / TURN_USERNAME / TURN_CREDENTIAL are
 * set (a half-configured relay is worse than none). TURN_URL may be a
 * comma-separated list. Creds are read server-side only — the huddle-ice
 * endpoint hands them to authenticated users at call time, never the bundle.
 */
export function iceServersFromEnv(env: {
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
}): IceServer[] {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const urls = (env.TURN_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls: urls.length === 1 ? urls[0] : urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL })
  }
  return servers
}
