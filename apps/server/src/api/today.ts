import { Hono } from 'hono'
import { z } from 'zod'
import { Today } from '../today/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const Instant = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO timestamp')
  .transform((s) => new Date(s).toISOString())

const DayQuery = z
  .object({
    from: Instant,
    to: Instant,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((q) => q.from < q.to && Date.parse(q.to) - Date.parse(q.from) <= 26 * 3_600_000, {
    message: 'from..to must be one day',
  })

/** `GET /api/today` (ARCHITECTURE §16): the Today page in one read. */
export function todayRoutes(
  deps: Pick<AppDeps, 'index' | 'spaces' | 'tasks' | 'notes' | 'meetings'>,
) {
  const today = new Today({
    index: deps.index,
    spaces: deps.spaces,
    tasks: deps.tasks.service,
    notes: deps.notes,
    calendar: deps.meetings.calendar,
  })
  return new Hono<AppEnv>().get('/today', valid('query', DayQuery), async (c) =>
    c.json(await today.view(c.get('principal'), c.req.valid('query'))),
  )
}
