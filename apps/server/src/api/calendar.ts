import { Hono } from 'hono'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { coverage, matchMeetEvent, type NoteRef } from '../meetings/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Meetings home asks for a refresh on every open; more often than this, the cache answers. */
const REFRESH_MAX_AGE_MS = 60_000
const Instant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO timestamp')
  .transform((s) => new Date(s).toISOString())

interface CalendarChoice {
  id: string
  name: string
  primary: boolean
  selected: boolean
  color?: string
}

/** ARCHITECTURE §7.2 and §7.8: the member's calendar, read from the sync's cache. */
export function calendarRoutes(deps: AppDeps) {
  const { calendar, calendarSync } = deps.meetings

  const status = (principal: Principal) => {
    if (!calendarSync) return { lastSyncedAt: null, error: null }
    const s = calendarSync.cache.status(principal.userId)
    return {
      lastSyncedAt: s.syncedAt === null ? null : new Date(s.syncedAt).toISOString(),
      error: s.error,
    }
  }

  /** Meeting notes by `calendar_event_id` in spaces the member reads, their own space first. */
  const notesByEvent = async (principal: Principal) => {
    const spaces = (await deps.spaces.visibleSpaces(principal)).sort(
      (a, b) => Number(b.kind === 'personal') - Number(a.kind === 'personal'),
    )
    const notes = new Map<string, NoteRef>()
    for (const space of spaces) {
      for (const file of deps.index.listFiles({ space: space.name, kind: 'meeting' })) {
        const id = file.frontmatter?.calendar_event_id
        if (file.frontmatter?.type !== 'meeting' || typeof id !== 'string' || notes.has(id))
          continue
        notes.set(id, { space: space.name, path: file.path, title: file.title })
      }
    }
    return notes
  }

  const choices = async (principal: Principal): Promise<CalendarChoice[]> => {
    if (!calendarSync) return [{ id: 'primary', name: 'Calendar', primary: true, selected: true }]
    const selected = new Set(calendarSync.cache.calendars(principal.userId))
    const listed = await calendarSync.google.listCalendars(principal)
    return listed
      .map((c) => ({
        id: c.id,
        name: c.name,
        primary: c.primary,
        selected: c.primary || selected.has(c.id),
        ...(c.color ? { color: c.color } : {}),
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
  }

  return new Hono<AppEnv>()
    .get(
      '/calendar/upcoming',
      valid('query', z.object({ from: Instant.optional(), to: Instant.optional() })),
      async (c) => {
        const query = c.req.valid('query')
        const from = query.from ?? new Date().toISOString()
        const to = query.to ?? new Date(Date.parse(from) + DAY_MS).toISOString()
        return c.json(await calendar.upcoming(c.get('principal'), { from, to }))
      },
    )
    .get('/calendar/status', (c) => c.json(status(c.get('principal'))))
    .post('/calendar/refresh', async (c) => {
      const principal = c.get('principal')
      await calendar.refresh?.(principal, { maxAgeMs: REFRESH_MAX_AGE_MS })
      return c.json(status(principal))
    })
    .get(
      '/calendar/match',
      valid('query', z.object({ meet: z.string().max(64).default('') })),
      async (c) => {
        const principal = c.get('principal')
        const now = Date.now()
        const events = await calendar.upcoming(principal, {
          from: new Date(now - 12 * HOUR_MS).toISOString(),
          to: new Date(now + 12 * HOUR_MS).toISOString(),
        })
        return c.json(matchMeetEvent(events, c.req.valid('query').meet, principal.email, now))
      },
    )
    .get(
      '/calendar/coverage',
      valid('query', z.object({ from: Instant.optional(), to: Instant.optional() })),
      async (c) => {
        const principal = c.get('principal')
        const query = c.req.valid('query')
        const now = Date.now()
        const to = query.to ?? new Date(now).toISOString()
        const from = query.from ?? new Date(Date.parse(to) - 14 * DAY_MS).toISOString()
        const events = await calendar.upcoming(principal, { from, to })
        const until = Math.min(now, Date.parse(to))
        return c.json(coverage(events, await notesByEvent(principal), principal.email, until))
      },
    )
    .get('/calendar/calendars', async (c) =>
      c.json({ calendars: await choices(c.get('principal')) }),
    )
    .put(
      '/calendar/calendars',
      valid('json', z.object({ ids: z.array(z.string().min(1).max(500)).max(50) })),
      async (c) => {
        const principal = c.get('principal')
        if (!calendarSync) throw new HearthError('bad_request', 'This calendar has no choices')
        const listed = await calendarSync.google.listCalendars(principal)
        const others = new Set(listed.filter((l) => !l.primary).map((l) => l.id))
        const primary = new Set(listed.filter((l) => l.primary).map((l) => l.id))
        const ids = c.req.valid('json').ids.filter((id) => id !== 'primary' && !primary.has(id))
        const unknown = ids.filter((id) => !others.has(id))
        if (unknown.length > 0) {
          throw new HearthError('bad_request', `Not one of your calendars: ${unknown.join(', ')}`)
        }
        calendarSync.cache.register(principal)
        calendarSync.cache.setCalendars(principal.userId, ids)
        // Fill the newly chosen calendars now; a failure is recorded and retried on the next pass.
        await calendarSync.resync(principal).catch(() => {})
        return c.json({ calendars: await choices(principal) })
      },
    )
}
