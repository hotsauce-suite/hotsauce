import { Hono } from 'hono'
import { z } from 'zod'
import { Today, TodayLayouts, Weather } from '../today/index.js'
import { readVersion } from '../updates/version.js'
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

const Place = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
})

/**
 * `GET /api/today` (ARCHITECTURE §16): the Today page in one read. Also the member's tile layout
 * (§16.4) and the header's weather (§16.5).
 */
export function todayRoutes(
  deps: Pick<AppDeps, 'index' | 'spaces' | 'tasks' | 'notes' | 'meetings' | 'git' | 'syncer'>,
) {
  const today = new Today({
    index: deps.index,
    spaces: deps.spaces,
    tasks: deps.tasks.service,
    notes: deps.notes,
    calendar: deps.meetings.calendar,
  })
  const layouts = new TodayLayouts({ git: deps.git, spaces: deps.spaces, syncer: deps.syncer })
  const weather = new Weather({ version: readVersion() })
  return new Hono<AppEnv>()
    .get('/today', valid('query', DayQuery), async (c) =>
      c.json(await today.view(c.get('principal'), c.req.valid('query'))),
    )
    .get('/today/layout', async (c) => c.json(await layouts.get(c.get('principal'))))
    .put('/today/layout', async (c) => {
      const body: unknown = await c.req.json().catch(() => null)
      const input = body && typeof body === 'object' && 'layout' in body ? body.layout : body
      return c.json(await layouts.save(c.get('principal'), input))
    })
    .get('/today/weather', valid('query', Place), async (c) => {
      const { lat, lon } = c.req.valid('query')
      return c.json(await weather.forecast(lat, lon, c.get('principal').email))
    })
}
