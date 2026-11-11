import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Principal } from '../../auth/index.js'
import type { CalendarEvent } from './types.js'

export const PRIMARY = 'primary'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL            -- JSON, as last seen
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    user_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    sync_token TEXT,
    full_synced_at INTEGER,
    synced_at INTEGER,
    PRIMARY KEY (user_id, calendar_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    user_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    event TEXT NOT NULL,               -- CalendarEvent JSON
    PRIMARY KEY (user_id, calendar_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS events_user_time ON events (user_id, start);
  CREATE TABLE IF NOT EXISTS member_status (
    user_id TEXT PRIMARY KEY,
    attempted_at INTEGER,
    synced_at INTEGER,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_choices (
    user_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    PRIMARY KEY (user_id, calendar_id)
  );
`

export interface SyncState {
  syncToken: string | null
  fullSyncedAt: number | null
  syncedAt: number | null
}

export interface MemberStatus {
  attemptedAt: number | null
  syncedAt: number | null
  error: string | null
}

/**
 * The calendar cache (ARCHITECTURE §7.8): each member's Google events, sync tokens and status in
 * `DATA_DIR/calendar/cache.sqlite`. Everything here can be fetched from Google again, except a
 * member's extra calendar choices, which reset to primary only if the file is deleted.
 */
export class CalendarCache {
  readonly #db: Database.Database

  /** `file` is a path, or ':memory:'. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('busy_timeout = 5000')
    this.#db.exec(SCHEMA)
  }

  close(): void {
    this.#db.close()
  }

  register(principal: Principal): void {
    const { userId, email, name, handle, isAdmin } = principal
    this.#db
      .prepare(
        'INSERT INTO members (user_id, principal) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET principal = excluded.principal',
      )
      .run(userId, JSON.stringify({ userId, email, name, handle, isAdmin }))
  }

  members(): Principal[] {
    return (
      this.#db.prepare('SELECT principal FROM members ORDER BY user_id').all() as Array<{
        principal: string
      }>
    ).map((r) => JSON.parse(r.principal) as Principal)
  }

  /** Primary, then the extra calendars the member chose, in id order. */
  calendars(userId: string): string[] {
    const extra = this.#db
      .prepare('SELECT calendar_id FROM calendar_choices WHERE user_id = ? ORDER BY calendar_id')
      .all(userId) as Array<{ calendar_id: string }>
    return [PRIMARY, ...extra.map((r) => r.calendar_id)]
  }

  /** Replace the member's extra calendars; events and sync state of dropped ones go too. */
  setCalendars(userId: string, extra: string[]): void {
    const keep = new Set(extra.filter((id) => id !== PRIMARY))
    this.#db
      .transaction(() => {
        for (const id of this.calendars(userId)) {
          if (id === PRIMARY || keep.has(id)) continue
          this.#db
            .prepare('DELETE FROM events WHERE user_id = ? AND calendar_id = ?')
            .run(userId, id)
          this.#db
            .prepare('DELETE FROM sync_state WHERE user_id = ? AND calendar_id = ?')
            .run(userId, id)
        }
        this.#db.prepare('DELETE FROM calendar_choices WHERE user_id = ?').run(userId)
        const insert = this.#db.prepare(
          'INSERT INTO calendar_choices (user_id, calendar_id) VALUES (?, ?)',
        )
        for (const id of keep) insert.run(userId, id)
      })
      .immediate()
  }

  /** Forget one extra calendar (Google no longer lets the member read it). */
  dropCalendar(userId: string, calendarId: string): void {
    if (calendarId === PRIMARY) return
    this.setCalendars(
      userId,
      this.calendars(userId).filter((id) => id !== calendarId),
    )
  }

  syncState(userId: string, calendarId: string): SyncState {
    const row = this.#db
      .prepare(
        'SELECT sync_token, full_synced_at, synced_at FROM sync_state WHERE user_id = ? AND calendar_id = ?',
      )
      .get(userId, calendarId) as
      | { sync_token: string | null; full_synced_at: number | null; synced_at: number | null }
      | undefined
    return {
      syncToken: row?.sync_token ?? null,
      fullSyncedAt: row?.full_synced_at ?? null,
      syncedAt: row?.synced_at ?? null,
    }
  }

  /**
   * A full sync's result: the calendar's events become exactly `events`, and its token is saved,
   * in one transaction.
   */
  replaceEvents(
    userId: string,
    calendarId: string,
    events: CalendarEvent[],
    syncToken: string | null,
    at: number,
  ): void {
    this.#db
      .transaction(() => {
        // Unticked while this sync was running: its events stay gone.
        if (!this.calendars(userId).includes(calendarId)) return
        this.#db
          .prepare('DELETE FROM events WHERE user_id = ? AND calendar_id = ?')
          .run(userId, calendarId)
        for (const event of events) this.#upsert(userId, calendarId, event)
        this.#saveState(userId, calendarId, syncToken, at, at)
      })
      .immediate()
  }

  /** An incremental sync's result: upserts, removals by id, and the next token. */
  applyChanges(
    userId: string,
    calendarId: string,
    changes: { upserts: CalendarEvent[]; removals: string[] },
    syncToken: string | null,
    at: number,
  ): void {
    this.#db
      .transaction(() => {
        if (!this.calendars(userId).includes(calendarId)) return
        const remove = this.#db.prepare(
          'DELETE FROM events WHERE user_id = ? AND calendar_id = ? AND event_id = ?',
        )
        // A removed id may be a whole series: its instances go with it.
        const removeSeries = this.#db.prepare(
          "DELETE FROM events WHERE user_id = ? AND calendar_id = ? AND json_extract(event, '$.seriesId') = ?",
        )
        for (const id of changes.removals) {
          remove.run(userId, calendarId, id)
          removeSeries.run(userId, calendarId, id)
        }
        for (const event of changes.upserts) this.#upsert(userId, calendarId, event)
        const fullSyncedAt = this.syncState(userId, calendarId).fullSyncedAt
        this.#saveState(userId, calendarId, syncToken, fullSyncedAt, at)
      })
      .immediate()
  }

  /** Forget a calendar's sync token, so the next sync is a full one. */
  clearSyncToken(userId: string, calendarId: string): void {
    this.#db
      .prepare('UPDATE sync_state SET sync_token = NULL WHERE user_id = ? AND calendar_id = ?')
      .run(userId, calendarId)
  }

  /**
   * The member's events overlapping `from`..`to` (ms) from the calendars they sync, in start
   * order; an event in two calendars is listed once, primary's copy first.
   */
  events(userId: string, from: number, to: number): CalendarEvent[] {
    const calendars = this.calendars(userId)
    const rows = this.#db
      .prepare(
        'SELECT calendar_id, event_id, event FROM events WHERE user_id = ? AND end > ? AND start < ? ORDER BY start, event_id',
      )
      .all(userId, from, to) as Array<{ calendar_id: string; event_id: string; event: string }>
    const byId = new Map<string, { calendar: string; event: CalendarEvent }>()
    for (const row of rows) {
      if (!calendars.includes(row.calendar_id)) continue
      const seen = byId.get(row.event_id)
      if (seen && (seen.calendar === PRIMARY || row.calendar_id !== PRIMARY)) continue
      const event = JSON.parse(row.event) as CalendarEvent
      if (row.calendar_id !== PRIMARY) event.calendarId = row.calendar_id
      byId.set(row.event_id, { calendar: row.calendar_id, event })
    }
    return [...byId.values()]
      .map((v) => v.event)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id))
  }

  /** Drop events that ended before `before` (ms). */
  prune(before: number): void {
    this.#db.prepare('DELETE FROM events WHERE end < ?').run(before)
  }

  status(userId: string): MemberStatus {
    const row = this.#db
      .prepare('SELECT attempted_at, synced_at, error FROM member_status WHERE user_id = ?')
      .get(userId) as
      | { attempted_at: number | null; synced_at: number | null; error: string | null }
      | undefined
    return {
      attemptedAt: row?.attempted_at ?? null,
      syncedAt: row?.synced_at ?? null,
      error: row?.error ?? null,
    }
  }

  /** Record a sync attempt: a success clears the error; a failure keeps the last success time. */
  recordAttempt(userId: string, at: number, error: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO member_status (user_id, attempted_at, synced_at, error) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET attempted_at = excluded.attempted_at,
           synced_at = COALESCE(excluded.synced_at, member_status.synced_at), error = excluded.error`,
      )
      .run(userId, at, error === null ? at : null, error)
  }

  #upsert(userId: string, calendarId: string, event: CalendarEvent): void {
    const { calendarId: _drop, ...stored } = event
    this.#db
      .prepare(
        `INSERT INTO events (user_id, calendar_id, event_id, start, end, event) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET start = excluded.start,
           end = excluded.end, event = excluded.event`,
      )
      .run(
        userId,
        calendarId,
        event.id,
        Date.parse(event.start),
        Date.parse(event.end),
        JSON.stringify(stored),
      )
  }

  #saveState(
    userId: string,
    calendarId: string,
    syncToken: string | null,
    fullSyncedAt: number | null,
    syncedAt: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO sync_state (user_id, calendar_id, sync_token, full_synced_at, synced_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, calendar_id) DO UPDATE SET sync_token = excluded.sync_token,
           full_synced_at = excluded.full_synced_at, synced_at = excluded.synced_at`,
      )
      .run(userId, calendarId, syncToken, fullSyncedAt, syncedAt)
  }
}
