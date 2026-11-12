import { Hono } from 'hono'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly } from './tokens.js'

/**
 * The Mac app's sign-in through the browser (ARCHITECTURE §9.4.1): the browser, already signed
 * in, asks for a one-time ticket and hands it to the app, which signs its own window in with it.
 * Only a signed-in browser session can ask: never an access token, never a Dictate device token
 * (the middleware keeps those to their own routes), so a token can't become a full session.
 */
export function desktopRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().post('/desktop/ticket', async (c) => {
    const principal = sessionOnly(c.get('principal'))
    const ticket = await deps.auth.createSignInTicket?.(principal.userId)
    if (!ticket) throw new Error('No sign-in ticket was made')
    c.header('Cache-Control', 'no-store')
    return c.json({ ticket })
  })
}
