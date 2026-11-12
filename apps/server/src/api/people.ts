import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_ABOUT, normalizeEmail } from '../people/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Email = z.object({
  email: z
    .string()
    .max(254)
    // Hono has already decoded the path parameter.
    .transform((s, ctx) => {
      try {
        return normalizeEmail(s)
      } catch {
        ctx.addIssue({ code: 'custom', message: 'expected an email address' })
        return z.NEVER
      }
    }),
})

/** People (ARCHITECTURE §17.4): everyone the member can read about, and the team's About notes. */
export function peopleRoutes(deps: Pick<AppDeps, 'people'>) {
  const people = deps.people
  return new Hono<AppEnv>()
    .get('/people', valid('query', z.object({ q: z.string().max(200).optional() })), async (c) =>
      c.json({ people: await people.list(c.get('principal'), c.req.valid('query')) }),
    )
    .get('/people/:email', valid('param', Email), async (c) =>
      c.json(await people.get(c.get('principal'), c.req.valid('param').email)),
    )
    .put(
      '/people/:email/about',
      valid('param', Email),
      valid(
        'json',
        z.object({
          text: z.string().max(MAX_ABOUT),
          blobOid: z.string().min(1).max(64).nullable(),
        }),
      ),
      async (c) => {
        const principal = c.get('principal')
        return c.json(
          await people.saveAbout(
            principal,
            c.req.valid('param').email,
            c.req.valid('json'),
            viaFor(principal),
          ),
        )
      },
    )
    .get(
      '/companies/:domain',
      valid('param', z.object({ domain: z.string().min(1).max(253) })),
      async (c) => c.json(await people.company(c.get('principal'), c.req.valid('param').domain)),
    )
}
