import { BOOKING_LENGTHS, MAX_BOOKING_QUESTIONS } from '@hearth/format'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

/** Prefix of the signed-out booking page's API (`isPublic` in middleware.ts). */
export const PUBLIC_BOOKING_PREFIX = '/api/book/'

const Slug = z.object({ slug: z.string().min(1).max(50) })
const Window = z.tuple([z.string().max(5), z.string().max(5)])
const Day = z.array(Window).max(4)

const LinkInput = z.object({
  title: z.string().max(120),
  minutes: z.number().refine((n) => (BOOKING_LENGTHS as readonly number[]).includes(n)),
  tz: z.string().max(64),
  hours: z.object({ sun: Day, mon: Day, tue: Day, wed: Day, thu: Day, fri: Day, sat: Day }),
  bufferBefore: z.number().int(),
  bufferAfter: z.number().int(),
  noticeMinutes: z.number().int(),
  horizonDays: z.number().int(),
  dailyCap: z.number().int().nullable(),
  questions: z.array(z.string().max(200)).max(MAX_BOOKING_QUESTIONS),
  description: z.string().max(1000),
  active: z.boolean(),
  blobOid: z.string().min(1).max(64).nullable(),
})

/** A member's own booking links (ARCHITECTURE §19.4). */
export function bookingRoutes(deps: Pick<AppDeps, 'bookings'>) {
  const bookings = deps.bookings
  return new Hono<AppEnv>()
    .get('/booking', async (c) => c.json(await bookings.status(c.get('principal'))))
    .put('/booking/:slug', valid('param', Slug), valid('json', LinkInput), async (c) =>
      c.json(
        await bookings.save(c.get('principal'), c.req.valid('param').slug, c.req.valid('json')),
      ),
    )
    .delete(
      '/booking/:slug',
      valid('param', Slug),
      valid('query', z.object({ blobOid: z.string().min(1).max(64) })),
      async (c) => {
        await bookings.remove(
          c.get('principal'),
          c.req.valid('param').slug,
          c.req.valid('query').blobOid,
        )
        return c.body(null, 204)
      },
    )
}

const PublicLink = z.object({
  handle: z.string().min(1).max(100),
  slug: z.string().min(1).max(50),
})

// The booking page is signed out, so nothing caps its body but this (middleware skips public paths).
const limitBookingBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new HearthError('bad_request', 'Request body is too large', { status: 413 })
  },
})

/**
 * The booker's address for rate limits: Fly's proxy sets fly-client-ip (the instance isn't
 * behind Cloudflare). IPv6 counts per /64, since one home or host holds a whole /64.
 */
export function clientIp(header: (name: string) => string | undefined): string | null {
  const ip =
    header('fly-client-ip')?.trim() || header('x-forwarded-for')?.split(',')[0]?.trim() || null
  if (!ip?.includes(':')) return ip
  const [head = '', tail = ''] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = ip.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/** The signed-out booking page (ARCHITECTURE §19.4). */
export function publicBookingRoutes(deps: Pick<AppDeps, 'bookings'>) {
  const bookings = deps.bookings
  return new Hono<AppEnv>()
    .get(
      '/book/:handle/:slug',
      valid('param', PublicLink),
      valid(
        'query',
        z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() }),
      ),
      async (c) => {
        const { handle, slug } = c.req.valid('param')
        const page = await bookings.page(handle, slug, {
          ...c.req.valid('query'),
          ip: clientIp((n) => c.req.header(n)),
        })
        c.header('cache-control', 'no-store')
        return c.json(page)
      },
    )
    .post(
      '/book/:handle/:slug',
      limitBookingBody,
      valid('param', PublicLink),
      valid(
        'json',
        z.object({
          start: z.string().max(40),
          name: z.string().max(200),
          email: z.string().max(254),
          answers: z.array(z.string().max(2000)).max(MAX_BOOKING_QUESTIONS).default([]),
          token: z.string().max(4096),
        }),
      ),
      async (c) => {
        const { handle, slug } = c.req.valid('param')
        return c.json(
          await bookings.book(handle, slug, {
            ...c.req.valid('json'),
            ip: clientIp((n) => c.req.header(n)),
          }),
        )
      },
    )
}
