import { MAX_DRAWN_SIGNATURE_CHARS, MAX_FIELDS } from '@hotsauce/format'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import { clientIp } from './booking.js'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Space = z.string().min(1).max(100)
const Params = z.object({ space: Space, id: z.string().min(1).max(40) })

const Create = z.object({
  fileSpace: Space,
  fileId: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
  space: Space.optional(),
})

const Draft = z.object({
  title: z.string().max(200),
  // Checked in full by the format's schema in the service.
  fields: z.array(z.unknown()).max(MAX_FIELDS),
  blobOid: z.string().min(1).max(64),
})

const SignInput = z.object({
  values: z
    .array(
      z.object({
        field: z.string().min(1).max(16),
        value: z.string().max(5000).optional(),
        checked: z.boolean().optional(),
        image: z.string().max(MAX_DRAWN_SIGNATURE_CHARS).optional(),
      }),
    )
    .max(MAX_FIELDS),
  consent: z.boolean(),
  blobOid: z.string().min(1).max(64),
})

/** Sign (docs/PLAN-sign.md R9): envelopes, their source PDF, and signing as a member. */
export function signRoutes(deps: Pick<AppDeps, 'sign'>) {
  const { sign } = deps
  return new Hono<AppEnv>()
    .get('/sign', (c) => c.json({ envelopes: sign.list(c.get('principal')) }))
    .post('/sign', valid('json', Create), async (c) => {
      const p = c.get('principal')
      return c.json(await sign.create(p, c.req.valid('json'), viaFor(p)))
    })
    .get('/sign/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      return c.json(await sign.get(c.get('principal'), space, id))
    })
    .get('/sign/:space/:id/source.pdf', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      const bytes = await sign.source(c.get('principal'), space, id)
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store',
      })
    })
    .put('/sign/:space/:id', valid('param', Params), valid('json', Draft), async (c) => {
      const { space, id } = c.req.valid('param')
      const p = c.get('principal')
      return c.json(await sign.saveDraft(p, space, id, c.req.valid('json'), viaFor(p)))
    })
    .post(
      '/sign/:space/:id/sign',
      // Drawn signatures are PNGs; a few of them fit well inside this.
      bodyLimit({
        maxSize: 4 * 1024 * 1024,
        onError: () => {
          throw new HotsauceError('bad_request', 'That’s too much to send at once')
        },
      }),
      valid('param', Params),
      valid('json', SignInput),
      async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        const meta = {
          ip: clientIp((n) => c.req.header(n)),
          agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
        }
        return c.json(await sign.sign(p, space, id, c.req.valid('json'), meta, viaFor(p)))
      },
    )
    .delete('/sign/:space/:id', valid('param', Params), async (c) => {
      const { space, id } = c.req.valid('param')
      const p = c.get('principal')
      await sign.remove(p, space, id, viaFor(p))
      return c.body(null, 204)
    })
}
