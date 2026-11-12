import type { Principal } from '../../auth/index.js'
import { HearthError } from '../../errors.js'
import { type CalendarCache, PRIMARY } from './cache.js'
import {
  classifyGoogleEvent,
  type EventsQuery,
  type GoogleCalendarApi,
  type GoogleEvent,
  SyncTokenExpired,
} from './google.js'
import type { CalendarEvent, CalendarSource } from './types.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A full sync asks for this window; incremental syncs follow changes from there. */
export const SYNC_BACK_MS = 30 * DAY
export const SYNC_AHEAD_MS = 15 * DAY
const BACK_MS = SYNC_BACK_MS
const AHEAD_MS = SYNC_AHEAD_MS
/** A full sync again after this, so instances entering the 14-day horizon show up. */
const FULL_EVERY_MS = DAY
/** Enough for any real calendar; stops a misbehaving page token from looping forever. */
const MAX_PAGES = 50
/** A member whose first sync failed is tried again on read after this. */
const NEVER_SYNCED_RETRY_MS = MINUTE

/**
 * Keeps each member's Google Calendar in the cache (ARCHITECTURE §7.8): every few minutes for
 * every registered member, on demand when Meetings home opens, and inline the first time a
 * member's calendar is read. Read-only: nothing is ever written to Google.
 */
export class CalendarSync {
  readonly #cache: CalendarCache
  readonly #google: GoogleCalendarApi
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #intervalMs: number
  readonly #inFlight = new Map<string, Promise<void>>()
  /** Each member's last logged failure, so a broken grant is logged once, not every pass. */
  readonly #logged = new Map<string, string>()
  #timer: ReturnType<typeof setInterval> | null = null
  #running: Promise<void> | null = null

  constructor(opts: {
    cache: CalendarCache
    google: GoogleCalendarApi
    now?: () => number
    log?: (message: string) => void
    intervalMs?: number
  }) {
    this.#cache = opts.cache
    this.#google = opts.google
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? console.error
    this.#intervalMs = opts.intervalMs ?? 5 * MINUTE
  }

  get cache(): CalendarCache {
    return this.#cache
  }

  get google(): GoogleCalendarApi {
    return this.#google
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.syncAll(), this.#intervalMs)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#running
    await Promise.allSettled(this.#inFlight.values())
  }

  /** One pass over every registered member, one at a time; failures are recorded, not thrown. */
  syncAll(): Promise<void> {
    this.#running ??= (async () => {
      for (const principal of this.#cache.members()) {
        await this.sync(principal).catch(() => {})
      }
    })().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  /** Sync now unless an attempt was made within `maxAgeMs`; failures are recorded, not thrown. */
  async refresh(principal: Principal, opts: { maxAgeMs: number }): Promise<void> {
    this.#cache.register(principal)
    const { attemptedAt } = this.#cache.status(principal.userId)
    if (attemptedAt !== null && this.#now() - attemptedAt < opts.maxAgeMs) {
      await this.#inFlight.get(principal.userId)
      return
    }
    await this.sync(principal).catch(() => {})
  }

  /** Sync the member's calendars now (joining one already running). Throws what failed. */
  sync(principal: Principal): Promise<void> {
    const running = this.#inFlight.get(principal.userId)
    if (running) return running
    const pass = this.#sync(principal).finally(() => this.#inFlight.delete(principal.userId))
    this.#inFlight.set(principal.userId, pass)
    return pass
  }

  /** A pass that starts after any running one, so it sees the member's current calendars. */
  async resync(principal: Principal): Promise<void> {
    await this.#inFlight.get(principal.userId)?.catch(() => {})
    await this.sync(principal)
  }

  /** The last failure of a member who has never synced, if it was within `withinMs`. */
  recentFirstFailure(userId: string, withinMs: number): HearthError | null {
    const { attemptedAt, syncedAt } = this.#cache.status(userId)
    const error = this.#lastError.get(userId)
    if (syncedAt !== null || attemptedAt === null || !error) return null
    return this.#now() - attemptedAt < withinMs ? error : null
  }

  readonly #lastError = new Map<string, HearthError>()

  async #sync(principal: Principal): Promise<void> {
    const { userId } = principal
    try {
      for (const calendarId of this.#cache.calendars(userId)) {
        try {
          await this.#syncCalendar(principal, calendarId)
        } catch (err) {
          // Primary failing is the member's failure. Another calendar failing doesn't stop the
          // rest; one Google no longer lets them read is dropped from their choices.
          if (calendarId === PRIMARY) throw err
          if (
            err instanceof HearthError &&
            (err.code === 'forbidden' || err.code === 'not_found')
          ) {
            this.#cache.dropCalendar(userId, calendarId)
            this.#log(
              `google calendar for ${principal.email}: dropped ${calendarId} (${err.message})`,
            )
          } else {
            this.#logOnce(principal, `${calendarId}: ${err instanceof Error ? err.message : err}`)
          }
        }
      }
      this.#cache.prune(this.#now() - BACK_MS)
      this.#cache.recordAttempt(userId, this.#now(), null)
      this.#logged.delete(userId)
      this.#lastError.delete(userId)
    } catch (err) {
      const error = err instanceof HearthError ? err : new HearthError('host_error', String(err))
      this.#cache.recordAttempt(userId, this.#now(), error.message)
      this.#lastError.set(userId, error)
      this.#logOnce(principal, error.message)
      throw error
    }
  }

  #logOnce(principal: Principal, message: string): void {
    if (this.#logged.get(principal.userId) === message) return
    this.#logged.set(principal.userId, message)
    this.#log(`google calendar for ${principal.email}: ${message}`)
  }

  async #syncCalendar(principal: Principal, calendarId: string): Promise<void> {
    const { userId } = principal
    const state = this.#cache.syncState(userId, calendarId)
    const now = this.#now()
    const fullDue = state.fullSyncedAt === null || now - state.fullSyncedAt >= FULL_EVERY_MS
    if (state.syncToken && !fullDue) {
      try {
        const { items, nextSyncToken } = await this.#list(principal, calendarId, {
          syncToken: state.syncToken,
        })
        this.#cache.applyChanges(
          userId,
          calendarId,
          changesOf(items, member(principal, calendarId)),
          nextSyncToken,
          now,
        )
        return
      } catch (err) {
        if (!(err instanceof SyncTokenExpired)) throw err
        // 410: Google forgot the token. Start over with a full sync in this same pass.
        this.#cache.clearSyncToken(userId, calendarId)
      }
    }
    const { items, nextSyncToken } = await this.#list(principal, calendarId, {
      timeMin: new Date(now - BACK_MS).toISOString(),
      timeMax: new Date(now + AHEAD_MS).toISOString(),
    })
    const events = items
      .map((item) => classifyGoogleEvent(item, member(principal, calendarId)))
      .filter((e): e is CalendarEvent => e !== null)
    this.#cache.replaceEvents(userId, calendarId, events, nextSyncToken, now)
  }

  /** Every page of one list request. */
  async #list(
    principal: Principal,
    calendarId: string,
    query: EventsQuery,
  ): Promise<{ items: GoogleEvent[]; nextSyncToken: string | null }> {
    const items: GoogleEvent[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#google.listEvents(principal, calendarId, { ...query, pageToken })
      items.push(...result.items)
      if (!result.nextPageToken) return { items, nextSyncToken: result.nextSyncToken ?? null }
      pageToken = result.nextPageToken
    }
    throw new HearthError('host_error', 'Google Calendar returned too many pages')
  }
}

/** On a calendar other than primary, `self` is that calendar's owner: judge by the member. */
function member(principal: Principal, calendarId: string): string | undefined {
  return calendarId === PRIMARY ? undefined : principal.email
}

/** An incremental page's items as cache changes: kept events upserted, the rest removed. */
export function changesOf(
  items: GoogleEvent[],
  forMember?: string,
): { upserts: CalendarEvent[]; removals: string[] } {
  const upserts: CalendarEvent[] = []
  const removals: string[] = []
  for (const item of items) {
    const event = classifyGoogleEvent(item, forMember)
    if (event) upserts.push(event)
    else removals.push(item.id)
  }
  return { upserts, removals }
}

/**
 * `CalendarSource` over the cache (ARCHITECTURE §7.8). A member never synced is synced inline
 * first and that sync's error is thrown; after one success, a failing Google leaves the cached
 * events in place, so reminders and the home screen keep working.
 */
export class CachedCalendar implements CalendarSource {
  readonly #sync: CalendarSync

  constructor(sync: CalendarSync) {
    this.#sync = sync
  }

  async upcoming(
    principal: Principal,
    range: { from: string; to: string },
  ): Promise<CalendarEvent[]> {
    const cache = this.#sync.cache
    cache.register(principal)
    if (cache.status(principal.userId).syncedAt === null) {
      // Never synced (no grant yet, say): ask Google at most once a minute, not on every read.
      const recent = this.#sync.recentFirstFailure(principal.userId, NEVER_SYNCED_RETRY_MS)
      if (recent) throw recent
      await this.#sync.sync(principal)
    }
    return cache.events(principal.userId, Date.parse(range.from), Date.parse(range.to))
  }

  refresh(principal: Principal, opts: { maxAgeMs: number }): Promise<void> {
    return this.#sync.refresh(principal, opts)
  }
}
