import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { MAX_TOKEN_NAME } from '../tokens/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

/**
 * The member's personal access tokens (ARCHITECTURE §8.1). Signed-in sessions only: a token can't
 * list, mint or revoke tokens, so a leaked one can't make more of itself.
 */
export function tokenRoutes(deps: Pick<AppDeps, 'tokens'>) {
  const { tokens } = deps
  return new Hono<AppEnv>()
    .basePath('/tokens')
    .get('/', async (c) => c.json(await tokens.list(sessionOnly(c.get('principal')))))
    .post(
      '/',
      valid('json', z.object({ name: z.string().trim().min(1).max(MAX_TOKEN_NAME) })),
      async (c) => {
        const created = await tokens.create(
          sessionOnly(c.get('principal')),
          c.req.valid('json').name,
        )
        return c.json(created, 201)
      },
    )
    .delete('/:id', async (c) => {
      await tokens.revoke(sessionOnly(c.get('principal')), c.req.param('id'))
      return c.body(null, 204)
    })
}

/**
 * Refuses a request made with an access token. Used where a token could outlive its own
 * revocation: minting tokens, and push subscriptions (a channel the server keeps sending to).
 */
export function sessionOnly(principal: AppEnv['Variables']['principal']) {
  if (principal.via?.kind === 'token') {
    throw new HearthError('forbidden', 'This needs a signed-in session, not an access token')
  }
  return principal
}

/** The `Hearth-Via` trailer for a save made with an access token over the HTTP API. */
export function viaFor(principal: AppEnv['Variables']['principal']): string | undefined {
  return principal.via?.kind === 'token' ? `api (token "${principal.via.tokenName}")` : undefined
}
