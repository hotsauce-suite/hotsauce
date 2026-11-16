import { Hono } from 'hono'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import { TEAM_SPACE } from '../spaces/index.js'
import { Places, roundPlace, Today, TodayLayouts, Weather } from '../today/index.js'
import { readVersion } from '../updates/version.js'
import type { AppDeps, AppEnv } from './env.js'
import { isMarkdown, titleOf } from './save.js'
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

/** A doc's link (or its address) as an admin pastes it, or null to clear. */
const StartHere = z.object({ link: z.string().trim().max(2000).nullable() })

/**
 * The team-space path a pasted doc link names: `https://…/docs/team/a/b.md` or `/docs/team/a/b.md`.
 * Null for anything else (another space, another app, another kind of file).
 */
export function startHerePath(link: string): string | null {
  let pathname: string
  try {
    pathname = new URL(link, 'http://x').pathname
  } catch {
    return null
  }
  const prefix = `/docs/${TEAM_SPACE}/`
  if (!pathname.startsWith(prefix)) return null
  let path: string
  try {
    path = pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (!isMarkdown(path) || path.split('/').some((part) => part === '' || part === '..')) return null
  return path
}

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
  /** The start-here doc as it is now, or null when none is picked or it has since gone. */
  const startHere = async () => {
    const path = deps.org.settings().startHereDoc
    if (!path) return null
    try {
      const { content } = await deps.git.readFile(TEAM_SPACE, path)
      return { path, title: titleOf(path, content) }
    } catch (err) {
      if (err instanceof HotsauceError && err.code === 'not_found') return null
      throw err
    }
  }
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
          throw new HotsauceError('bad_request', 'Send both lat and lon, or neither')
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
          throw new HotsauceError('forbidden', 'Only an admin can set the team’s weather city')
        }
        const { place } = c.req.valid('json')
        return c.json({ place: deps.org.saveSettings({ weatherPlace: place }).weatherPlace })
      })
      // The doc Getting started opens for "See where the team's work lives" (PLAN-getting-started H1).
      .get('/today/start-here', async (c) => c.json({ doc: await startHere() }))
      .put('/today/start-here', valid('json', StartHere), async (c) => {
        const p = c.get('principal')
        if (!p.isAdmin || p.via) {
          throw new HotsauceError('forbidden', 'Only an admin can pick the team’s start-here doc')
        }
        const { link } = c.req.valid('json')
        if (!link) {
          deps.org.saveSettings({ startHereDoc: '' })
          return c.json({ doc: null })
        }
        const path = startHerePath(link)
        const found = path
          ? await deps.git.readFile(TEAM_SPACE, path).catch((err: unknown) => {
              if (err instanceof HotsauceError && err.code === 'not_found') return null
              throw err
            })
          : null
        if (!path || !found) {
          throw new HotsauceError(
            'bad_request',
            'That isn’t a doc in the Team space. Open the doc, copy its address from the browser, and paste it here.',
          )
        }
        deps.org.saveSettings({ startHereDoc: path })
        return c.json({ doc: { path, title: titleOf(path, found.content) } })
      })
  )
}
