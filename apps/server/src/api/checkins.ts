import { WEEKDAYS } from '@hearth/format'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { viaFor } from './tokens.js'
import { valid } from './validate.js'

const Id = z.object({ id: z.string().min(1).max(40) })
const Tz = z.object({ tz: z.string().min(1).max(64).optional() })
const Input = z.object({
  title: z.string().max(400),
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  room: z.string().max(40).nullable(),
  skip: z.array(z.string().max(320)).max(500),
  paused: z.boolean(),
})

/**
 * Check-ins (ARCHITECTURE §24.4). Every route takes the browser's `tz` when it can, so a round
 * opens at the member's own time; managing a check-in is for admins in a session (the service).
 */
export function checkinRoutes(deps: Pick<AppDeps, 'checkins'>) {
  const { checkins } = deps
  return new Hono<AppEnv>()
    .get('/checkins', valid('query', Tz), async (c) => {
      const p = c.get('principal')
      await checkins.enrol(p, c.req.valid('query').tz)
      return c.json({ checkins: await checkins.list(p), canManage: p.isAdmin && !p.via })
    })
    .get('/checkins/due', valid('query', Tz), async (c) => {
      const p = c.get('principal')
      await checkins.enrol(p, c.req.valid('query').tz)
      return c.json({ due: await checkins.due(p) })
    })
    .post('/checkins', valid('query', Tz), valid('json', Input), async (c) => {
      const p = c.get('principal')
      const { tz } = c.req.valid('query')
      await checkins.enrol(p, tz)
      return c.json(await checkins.create(p, c.req.valid('json'), tz))
    })
    .get('/checkins/:id', valid('param', Id), valid('query', Tz), async (c) => {
      const p = c.get('principal')
      await checkins.enrol(p, c.req.valid('query').tz)
      return c.json(await checkins.get(p, c.req.valid('param').id))
    })
    .put(
      '/checkins/:id',
      valid('param', Id),
      valid('json', Input.extend({ blobOid: z.string().min(1).max(64) })),
      async (c) =>
        c.json(
          await checkins.save(c.get('principal'), c.req.valid('param').id, c.req.valid('json')),
        ),
    )
    .delete('/checkins/:id', valid('param', Id), async (c) => {
      await checkins.remove(c.get('principal'), c.req.valid('param').id)
      return c.body(null, 204)
    })
    .post(
      '/checkins/:id/answers',
      valid('param', Id),
      valid('query', Tz),
      valid(
        'json',
        z.object({
          text: z.string().max(20_000),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
      ),
      async (c) => {
        const p = c.get('principal')
        await checkins.enrol(p, c.req.valid('query').tz)
        const { text, date } = c.req.valid('json')
        return c.json(
          await checkins.answer(p, c.req.valid('param').id, text, {
            ...(date ? { date } : {}),
            via: viaFor(p),
          }),
        )
      },
    )
    .post(
      '/checkins/:id/answers/:answer/replies',
      valid('param', Id.extend({ answer: z.string().min(1).max(40) })),
      valid('json', z.object({ text: z.string().max(5_000) })),
      async (c) => {
        const p = c.get('principal')
        const { id, answer } = c.req.valid('param')
        return c.json(await checkins.reply(p, id, answer, c.req.valid('json').text, viaFor(p)))
      },
    )
}
