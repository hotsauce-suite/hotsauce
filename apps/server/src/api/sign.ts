import { isIP } from 'node:net'
import {
  MAX_DECLINE_REASON,
  MAX_DRAWN_SIGNATURE_CHARS,
  MAX_FIELDS,
  MAX_SIGNERS,
} from '@hotsauce/format'
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
  signers: z.array(z.unknown()).max(MAX_SIGNERS).optional(),
  signingOrder: z.enum(['parallel', 'sequential']).optional(),
  blobOid: z.string().min(1).max(64),
})

const MarkKind = z.object({ kind: z.enum(['signature', 'initials']) })
const Mark = z.discriminatedUnion('input', [
  z.object({ input: z.literal('typed'), value: z.string().max(200) }),
  z.object({
    input: z.enum(['drawn', 'uploaded']),
    image: z.string().max(MAX_DRAWN_SIGNATURE_CHARS),
  }),
])

const SignerParams = Params.extend({ signer: z.string().min(1).max(16) })
const Token = z.object({ token: z.string().min(1).max(200) })

const Values = z
  .array(
    z.object({
      field: z.string().min(1).max(16),
      value: z.string().max(5000).optional(),
      checked: z.boolean().optional(),
      image: z.string().max(MAX_DRAWN_SIGNATURE_CHARS).optional(),
      input: z.enum(['typed', 'drawn', 'uploaded']).optional(),
    }),
  )
  .max(MAX_FIELDS)

const SignInput = z.object({
  values: Values,
  consent: z.boolean(),
  blobOid: z.string().min(1).max(64),
})

/** Prefix of the signing page's API for people with a link (`isPublic` in middleware.ts). */
export const SIGN_LINK_PREFIX = '/api/sign-link/'

// Drawn signatures are PNGs; a few of them fit well inside this.
const signBody = () =>
  bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new HotsauceError('bad_request', 'That’s too much to send at once')
    },
  })

/** Sign (docs/PLAN-sign.md R9): envelopes, their source PDF, and signing as a member. */
export function signRoutes(deps: Pick<AppDeps, 'sign'>) {
  const { sign } = deps
  return (
    new Hono<AppEnv>()
      .get('/sign', (c) => c.json({ envelopes: sign.list(c.get('principal')) }))
      // The member's saved signature and initials (docs/PLAN-sign-saved-signature.md).
      .get('/sign-saved', async (c) => c.json(await sign.saved(c.get('principal'))))
      .put(
        '/sign-saved/:kind',
        signBody(),
        valid('param', MarkKind),
        valid('json', Mark),
        async (c) => {
          const p = c.get('principal')
          const { kind } = c.req.valid('param')
          return c.json(await sign.saveMark(p, kind, c.req.valid('json'), viaFor(p)))
        },
      )
      .delete('/sign-saved/:kind', valid('param', MarkKind), async (c) => {
        const p = c.get('principal')
        return c.json(await sign.removeMark(p, c.req.valid('param').kind, viaFor(p)))
      })
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
        '/sign/:space/:id/send',
        valid('param', Params),
        valid('json', z.object({ blobOid: z.string().min(1).max(64) })),
        async (c) => {
          const { space, id } = c.req.valid('param')
          const p = c.get('principal')
          return c.json(await sign.send(p, space, id, c.req.valid('json'), metaOf(c), viaFor(p)))
        },
      )
      .post(
        '/sign/:space/:id/link/:signer',
        valid('param', SignerParams),
        valid('json', z.object({ email: z.boolean() })),
        async (c) => {
          const { space, id, signer } = c.req.valid('param')
          const p = c.get('principal')
          return c.json(await sign.link(p, space, id, signer, c.req.valid('json'), viaFor(p)))
        },
      )
      .patch(
        '/sign/:space/:id/people/:signer',
        valid('param', SignerParams),
        valid(
          'json',
          z.object({ name: z.string().max(120).optional(), email: z.string().max(320).optional() }),
        ),
        async (c) => {
          const { space, id, signer } = c.req.valid('param')
          const p = c.get('principal')
          return c.json(
            await sign.correct(p, space, id, signer, c.req.valid('json'), metaOf(c), viaFor(p)),
          )
        },
      )
      .post('/sign/:space/:id/copy', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        return c.json(await sign.copy(p, space, id, viaFor(p)))
      })
      .post(
        '/sign/:space/:id/sign',
        signBody(),
        valid('param', Params),
        valid('json', SignInput),
        async (c) => {
          const { space, id } = c.req.valid('param')
          const p = c.get('principal')
          return c.json(await sign.sign(p, space, id, c.req.valid('json'), metaOf(c), viaFor(p)))
        },
      )
      .delete('/sign/:space/:id', valid('param', Params), async (c) => {
        const { space, id } = c.req.valid('param')
        const p = c.get('principal')
        await sign.remove(p, space, id, viaFor(p))
        return c.body(null, 204)
      })
  )
}

/**
 * Signing from an emailed link, with no account (R14). The link's 256-bit secret is the key:
 * nothing here is reachable without it.
 */
/** Requests to signing links from one address, per window. */
const LINK_REQUESTS = 300
const LINK_WINDOW_MS = 10 * 60_000

export function signLinkRoutes(deps: Pick<AppDeps, 'sign'>) {
  const { sign } = deps
  const noStore = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
  // Signed out, so each address gets a budget: plenty to read and sign, too few to guess links.
  const seen = new Map<string, { count: number; until: number }>()
  return new Hono<AppEnv>()
    .use('/sign-link/*', async (c, next) => {
      const ip = clientIp((n) => c.req.header(n)) ?? 'unknown'
      const now = Date.now()
      const hit = seen.get(ip)
      if (!hit || hit.until < now) {
        if (seen.size > 10_000) seen.clear()
        seen.set(ip, { count: 1, until: now + LINK_WINDOW_MS })
      } else if (++hit.count > LINK_REQUESTS) {
        throw new HotsauceError(
          'bad_request',
          'Too many tries. Wait a few minutes and open the link again',
          {
            status: 429,
          },
        )
      }
      await next()
    })
    .get('/sign-link/:token', valid('param', Token), async (c) =>
      c.json(await sign.publicView(c.req.valid('param').token, metaOf(c)), 200, noStore),
    )
    .get('/sign-link/:token/source.pdf', valid('param', Token), async (c) => {
      const bytes = await sign.publicSource(c.req.valid('param').token)
      return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'application/pdf', ...noStore })
    })
    .post(
      '/sign-link/:token/sign',
      signBody(),
      valid('param', Token),
      valid('json', z.object({ values: Values, consent: z.boolean() })),
      async (c) =>
        c.json(
          await sign.publicSign(c.req.valid('param').token, c.req.valid('json'), metaOf(c)),
          200,
          noStore,
        ),
    )
    .post(
      '/sign-link/:token/decline',
      bodyLimit({
        maxSize: 16 * 1024,
        onError: () => {
          throw new HotsauceError('bad_request', 'That’s too much to send at once')
        },
      }),
      valid('param', Token),
      valid('json', z.object({ reason: z.string().max(MAX_DECLINE_REASON) })),
      async (c) =>
        c.json(
          await sign.publicDecline(c.req.valid('param').token, c.req.valid('json'), metaOf(c)),
          200,
          noStore,
        ),
    )
}

/** Where a request came from, for the audit trail. */
function metaOf(c: { req: { header: (name: string) => string | undefined } }) {
  return {
    ip: signerIp((n) => c.req.header(n)),
    agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
  }
}

/**
 * The address a signing came from, for the audit trail: Fly's client header, else the first
 * forwarded address, kept only when it is a real IP address (anything else is left out).
 */
export function signerIp(header: (name: string) => string | undefined): string | null {
  for (const raw of [header('fly-client-ip'), header('x-forwarded-for')?.split(',')[0]]) {
    const ip = raw?.trim() ?? ''
    if (ip && isIP(ip)) return ip
  }
  return null
}
