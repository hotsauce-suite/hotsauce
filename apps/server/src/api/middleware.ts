import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { authenticateDevice, deviceTokenFrom, MAX_DICTATION_BYTES } from '../dictation/index.js'
import { type ErrorCode, HearthError } from '../errors.js'
import { CLIP_MEDIA_PREFIX } from './clips.js'
import type { AppDeps, AppEnv } from './env.js'

// Above the 10 MB upload limit, which the assets route checks itself.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024
const DICTATION_UPLOAD = '/api/dictation/transcribe'

/**
 * The only requests a Hearth Dictate device token can make. Anything else with one is refused,
 * so a token lifted from a Mac can dictate and edit the word lists, but never read a document.
 */
function deviceTokenMayCall(method: string, path: string): boolean {
  return (
    (method === 'POST' && path === DICTATION_UPLOAD) ||
    ((method === 'GET' || method === 'PUT') && path === '/api/dictation/words') ||
    // A Mac disconnecting (or replacing) itself.
    (method === 'DELETE' && path === '/api/dictation/devices/self')
  )
}

// Reachable without a session: the health check, host webhooks, and clip media (both carry a
// signature; a <video> element can't send a bearer token).
function isPublic(path: string): boolean {
  return (
    path === '/api/health' ||
    path.startsWith('/api/webhooks/') ||
    // The brand kit (the sign-in page shows it) and the setup wizard, which checks its own token.
    path.startsWith('/api/org/') ||
    path.startsWith('/api/setup/') ||
    path.startsWith(CLIP_MEDIA_PREFIX)
  )
}

// Why a member's personal space can't be provisioned right now: another member holds their handle,
// or the Git host is down. Neither should cost them the team space.
const TEAM_ONLY: ReadonlySet<ErrorCode> = new Set(['forbidden', 'host_error', 'push_failed'])

/**
 * Authenticates every other `/api` request and provisions the member's personal space on their
 * first one (a no-op afterwards). If that fails, the member carries on with the team space alone.
 */
export function authenticate(deps: Pick<AppDeps, 'auth' | 'spaces' | 'dictation'>) {
  // Members already logged as team-only, so a failure is logged once rather than per request.
  const teamOnly = new Set<string>()
  return createMiddleware<AppEnv>(async (c, next) => {
    if (isPublic(c.req.path)) return next()
    const deviceToken = deviceTokenFrom(c.req.header('authorization'))
    if (deviceToken !== null) {
      if (!deviceTokenMayCall(c.req.method, c.req.path)) {
        throw new HearthError('unauthorized', 'A Hearth Dictate device can only dictate')
      }
      const { principal, deviceId } = await authenticateDevice(
        deps.auth,
        deps.dictation.store,
        deviceToken,
      )
      c.set('principal', principal)
      c.set('deviceId', deviceId)
      return next()
    }
    const principal = await deps.auth.authenticate(c.req.raw)
    if (principal === null) throw new HearthError('unauthorized', 'Sign in first')
    try {
      await deps.spaces.ensurePersonalSpace(principal)
      teamOnly.delete(principal.email)
    } catch (err) {
      if (!(err instanceof HearthError && TEAM_ONLY.has(err.code))) throw err
      if (!teamOnly.has(principal.email)) {
        teamOnly.add(principal.email)
        console.warn(`${principal.email} has team access only: ${err.code}: ${err.message}`)
      }
    }
    c.set('principal', principal)
    await next()
  })
}

/**
 * Caps every authenticated request body. Mounted after `authenticate`, so an anonymous request's
 * body is never read; the webhook has its own smaller limit, behind its signature check.
 */
export function limitBody() {
  const tooLarge = () => {
    throw new HearthError('bad_request', 'Request body is too large', { status: 413 })
  }
  const limit = bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: tooLarge })
  // A dictation is up to 15 MB of audio; the route checks it again.
  const dictation = bodyLimit({ maxSize: MAX_DICTATION_BYTES, onError: tooLarge })
  return createMiddleware<AppEnv>((c, next) => {
    if (isPublic(c.req.path)) return next()
    return c.req.path === DICTATION_UPLOAD ? dictation(c, next) : limit(c, next)
  })
}

/** Every `/api/spaces/:space/*` route: team for every member, a personal space for its owner only. */
export function authorizeSpace(deps: Pick<AppDeps, 'spaces'>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const space = c.req.param('space') ?? ''
    if (!deps.spaces.canAccess(c.get('principal'), space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
    await next()
  })
}
