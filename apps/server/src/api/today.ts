import { Hono } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import { Places, Today, TodayLayouts, Weather } from '../today/index.js'
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
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
})

const PlaceQuery = z.object({ q: z.string().max(200).default('') })

/** The team's default weather place, or null to clear it. */
const DefaultPlace = z.object({
  place: z
    .object({
      name: z.string().trim().min(1).max(80),
      detail: z.string().trim().max(120).default(''),
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .nullable(),
})

/**
 * `GET /api/today` (ARCHITECTURE §16): the Today page in one read. Also the member's tile layout
 * (§16.4) and the header's weather (§16.5): by position, by a searched place, or the team default.
 */
export function todayRoutes(
  deps: Pick<
    AppDeps,
    'index' | 'spaces' | 'tasks' | 'notes' | 'meetings' | 'git' | 'syncer' | 'org'
  >,
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
  const places = new Places({ version: readVersion() })
  const teamPlace = () => deps.org.settings().weatherPlace
  return (
    new Hono<AppEnv>()
      .get('/today', valid('query', DayQuery), async (c) =>
        c.json(await today.view(c.get('principal'), c.req.valid('query'))),
      )
      .get('/today/layout', async (c) => c.json(await layouts.get(c.get('principal'))))
      .put('/today/layout', async (c) => {
        const body: unknown = await c.req.json().catch(() => null)
        const input = body && typeof body === 'object' && 'layout' in body ? body.layout : body
        return c.json(await layouts.save(c.get('principal'), input))
      })
      // With no position: the team's default place, or null when there's none.
      .get('/today/weather', valid('query', Place), async (c) => {
        const { lat, lon } = c.req.valid('query')
        const who = c.get('principal').email
        if (lat !== undefined && lon !== undefined)
          return c.json(await weather.forecast(lat, lon, who))
        if (lat !== undefined || lon !== undefined) {
          throw new HearthError('bad_request', 'Send both lat and lon, or neither')
        }
        const team = teamPlace()
        if (!team) return c.json(null)
        return c.json({ ...(await weather.forecast(team.lat, team.lon, who)), place: team.name })
      })
      .get('/today/places', valid('query', PlaceQuery), async (c) =>
        c.json({ places: await places.search(c.req.valid('query').q, c.get('principal').email) }),
      )
      // Any member may see the default (the header names it); only an admin in a session sets it.
      .get('/today/default-place', (c) => c.json({ place: teamPlace() }))
      .put('/today/default-place', valid('json', DefaultPlace), (c) => {
        const p = c.get('principal')
        if (!p.isAdmin || p.via) {
          throw new HearthError('forbidden', 'Only an admin can set the team’s weather city')
        }
        const { place } = c.req.valid('json')
        return c.json({ place: deps.org.saveSettings({ weatherPlace: place }).weatherPlace })
      })
  )
}
