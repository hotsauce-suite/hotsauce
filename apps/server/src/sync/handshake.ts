import { z } from 'zod'
import { type Authenticator, DEV_USER_HEADER, type Principal } from '../auth/index.js'

/** Close code for a client that didn't authenticate (in time, or at all). */
export const WS_UNAUTHORIZED = 4401

/** A Clerk session JWT is a few KiB; nothing a client sends before `ready` needs more. */
export const MAX_AUTH_FRAME_BYTES = 16 * 1024

const AuthMessage = z.union([
  z.object({ type: z.literal('auth'), token: z.string().min(1) }),
  z.object({ type: z.literal('auth'), devUser: z.string().min(1) }),
])

/**
 * The principal a WebSocket's first message authenticates as, or null. Browsers can't set
 * headers on a WebSocket and tokens must stay out of URLs, so the client sends
 * `{ type: 'auth', token }` (a Clerk session JWT) or `{ type: 'auth', devUser }` (dev mode), and
 * it goes through the same Authenticator as the API. A domain-lock refusal or an unreachable
 * Clerk is null too.
 */
export async function principalFromAuthMessage(
  auth: Authenticator,
  url: string,
  data: string,
): Promise<Principal | null> {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const message = AuthMessage.safeParse(json)
  if (!message.success) return null
  try {
    // Inside the try: a value that isn't a valid header (a newline in it) makes set() throw.
    const headers = new Headers()
    if ('token' in message.data) headers.set('authorization', `Bearer ${message.data.token}`)
    else headers.set(DEV_USER_HEADER, message.data.devUser)
    const principal = await auth.authenticate(new Request(url, { headers }))
    // Access tokens are for /api and /mcp; a socket would keep running after a revoke.
    return principal?.via?.kind === 'token' ? null : principal
  } catch {
    return null
  }
}
