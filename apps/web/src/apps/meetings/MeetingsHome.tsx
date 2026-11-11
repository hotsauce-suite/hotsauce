import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { calendarApi } from '../../api/calendar'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import type {
  CalendarEvent,
  CalendarStatus,
  CoverageItem,
  MeetingFilters,
  MeetingSession,
  MeetingState,
  MeetingSummary,
} from '../../api/types'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { meetingUrl } from '../../lib/paths'
import { useSession } from '../../state/session'
import { ActionItems } from './ActionItems'
import { MeetingsPageHeader, primaryButton, secondaryButton } from './components/common'
import { useNow } from './components/RecordingIndicator'
import { attendeeName, dayKey, dayLabel, startOfDay, timeLabel } from './format'
import { disableReminders, enableReminders, type ReminderState, reminderState } from './reminders'
import { useMeetingList } from './useMeetingList'

const CALENDAR_REFRESH_MS = 60_000
const SOON_MS = 10 * 60_000

/**
 * The calendar, from the server's cache: asks it to sync with Google once when the page opens
 * (then reloads), and re-reads every minute. `status` is the last sync's outcome.
 */
function useUpcoming(): {
  events: CalendarEvent[]
  failed: string | null
  status: CalendarStatus | null
  /** Bumps when the opening refresh has finished, for anything else read from the cache. */
  refreshed: number
} {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  // Why the calendar didn't load: the server's reason when it refused (a missing calendar
  // grant says what to do), else a plain fallback.
  const [failed, setFailed] = useState<string | null>(null)
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [refreshed, setRefreshed] = useState(0)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      const from = startOfDay(new Date())
      const to = new Date(from.getTime() + 8 * 86_400_000)
      calendarApi.upcoming({ from: from.toISOString(), to: to.toISOString() }).then(
        (list) => {
          if (cancelled) return
          setEvents(list)
          setFailed(null)
        },
        (err: unknown) => {
          if (cancelled) return
          setFailed(
            err instanceof HearthApiError && err.status === 403
              ? err.message
              : 'Your calendar didn’t load.',
          )
        },
      )
    }
    load()
    calendarApi
      .refresh()
      .then(
        (s) => {
          if (!cancelled) setStatus(s)
        },
        () => {},
      )
      .finally(() => {
        if (cancelled) return
        load()
        setRefreshed((n) => n + 1)
      })
    const timer = setInterval(() => {
      load()
      calendarApi.status().then(
        (s) => {
          if (!cancelled) setStatus(s)
        },
        () => {},
      )
    }, CALENDAR_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return { events, failed, status, refreshed }
}

/** Past meetings with others and whether they have notes; none when the server can't say. */
function useCoverage(refreshed: number): CoverageItem[] {
  const [items, setItems] = useState<CoverageItem[]>([])
  useEffect(() => {
    if (refreshed === 0) return
    let cancelled = false
    calendarApi.coverage().then(
      (list) => {
        if (!cancelled && Array.isArray(list)) setItems(list)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [refreshed])
  return items
}

/** The member's meetings not saved yet; none when the server can't say (it's a convenience). */
function useUnsavedSessions(): MeetingSession[] {
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  useEffect(() => {
    let cancelled = false
    meetingsApi.unsavedSessions().then(
      (list) => {
        if (!cancelled && Array.isArray(list)) setSessions(list)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [])
  return sessions
}

function groupByDay<T>(items: T[], dateOf: (item: T) => Date): Array<{ day: Date; items: T[] }> {
  const groups = new Map<string, { day: Date; items: T[] }>()
  for (const item of items) {
    const date = dateOf(item)
    const key = dayKey(date)
    const group = groups.get(key) ?? { day: date, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** `/meetings`: what's coming up, then every meeting by day, with filters. */
export default function MeetingsHome() {
  const { events, failed, status, refreshed } = useUpcoming()
  const coverage = useCoverage(refreshed)
  const unsaved = useUnsavedSessions()
  const [filters, setFilters] = useState<MeetingFilters>({})
  const list = useMeetingList(filters)
  const now = useNow(30_000)

  useEffect(() => {
    document.title = `${product()} Meetings`
  }, [])

  const upcoming = events.filter((e) => Date.parse(e.end) > now)

  return (
    <>
      <MeetingsPageHeader title={`${product()} Meetings`}>
        <Link
          to="/meetings/start"
          data-testid="new-meeting"
          className={`${primaryButton} h-9 px-3`}
        >
          <Icon name="mic" />
          New meeting
        </Link>
      </MeetingsPageHeader>
      <div data-testid="meetings-home" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8 md:pt-10">
          {unsaved.length > 0 ? (
            <ul aria-label="Meetings not saved yet" className="mb-8 space-y-2">
              {unsaved.map((s) => (
                <UnsavedRow key={s.id} session={s} now={now} />
              ))}
            </ul>
          ) : null}
          <section aria-labelledby="coming-up">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2
                id="coming-up"
                className="font-display text-[1.6rem] font-semibold tracking-tight"
              >
                Coming up
              </h2>
              <ReminderToggle />
            </div>
            {failed ? (
              <p data-testid="calendar-failed" className="mt-2 text-sm text-ink-soft">
                {failed} You can still start a meeting yourself.
              </p>
            ) : status?.error ? (
              <CalendarStatusLine status={status} error={status.error} now={now} />
            ) : null}
            {!failed && upcoming.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">Nothing else on your calendar this week.</p>
            ) : null}
            {groupByDay(upcoming, (e) => new Date(e.start)).map((group) => (
              <div key={dayKey(group.day)} className="mt-4">
                <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  {dayLabel(group.day, new Date(now))}
                </h3>
                <ul className="space-y-2">
                  {group.items.map((event) => (
                    <EventRow key={event.id} event={event} now={now} />
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <RecentMeetings items={coverage} now={now} />

          <ActionItems />

          <section aria-labelledby="past-meetings" className="mt-12">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2
                id="past-meetings"
                className="font-display text-[1.6rem] font-semibold tracking-tight"
              >
                Meetings
              </h2>
              <Filters filters={filters} onChange={setFilters} />
            </div>
            <MeetingList list={list.meetings} status={list.status} error={list.error} now={now} />
          </section>
        </div>
      </div>
    </>
  )
}

/** The calendar shown is the cached one, because the last sync with Google failed. */
function CalendarStatusLine({
  status,
  error,
  now,
}: {
  status: CalendarStatus
  error: string
  now: number
}) {
  const synced = status.lastSyncedAt ? new Date(status.lastSyncedAt) : null
  const day = synced ? dayLabel(synced, new Date(now)) : null
  const when = synced
    ? `Calendar last updated ${day === 'Today' ? '' : `${day}, `}${timeLabel(synced)}`
    : 'Calendar not updated yet'
  return (
    <p data-testid="calendar-status" className="mt-2 text-xs text-ink-faint">
      {when} — Google didn’t answer: {error}
    </p>
  )
}

/** The last two weeks' meetings with others, newest first, and whether each has notes. */
function RecentMeetings({ items, now }: { items: CoverageItem[]; now: number }) {
  const session = useSession()
  if (items.length === 0) return null
  return (
    <section aria-labelledby="recent-meetings" className="mt-12">
      <h2 id="recent-meetings" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Recent meetings
      </h2>
      <ul
        data-testid="coverage"
        className="mt-4 divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/50"
      >
        {items.map(({ event, note }) => {
          const start = new Date(event.start)
          const day = dayLabel(start, new Date(now))
          const others = event.attendees.filter((a) => a.email !== session.me?.principal.email)
          return (
            <li
              key={event.id}
              data-testid="coverage-item"
              data-event-id={event.id}
              data-has-notes={note ? 'true' : 'false'}
              className="flex items-center gap-4 px-4 py-2.5"
            >
              <span className="w-24 shrink-0 text-sm tabular-nums">
                <span className="block truncate text-ink-soft">{day}</span>
                <span className="block text-xs text-ink-faint">{timeLabel(start)}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{event.title}</span>
                <span className="block truncate text-sm text-ink-soft">
                  {others.map((a) => a.name ?? attendeeName(a.email)).join(', ')}
                </span>
              </span>
              {note ? (
                <Link
                  to={meetingUrl(note.space, note.path)}
                  data-testid="coverage-note-link"
                  className="shrink-0 text-sm text-ink underline decoration-ash-strong underline-offset-2 hover:decoration-ember"
                >
                  Notes
                </Link>
              ) : (
                <span className="shrink-0 text-sm text-ink-faint">No notes</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const reminderNote = (): Partial<Record<ReminderState, string>> => ({
  blocked: `Notifications are blocked for ${product()} in this browser’s settings.`,
  unsupported: `This browser can’t show reminders. On iPhone, add ${product()} to your Home Screen first.`,
})

/** A notification a minute before each meeting with attendees, on this browser. */
function ReminderToggle() {
  const [state, setState] = useState<ReminderState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    reminderState().then(
      (s) => live && setState(s),
      () => live && setState('unavailable'),
    )
    return () => {
      live = false
    }
  }, [])
  if (state === null || state === 'unavailable') return null
  const note = reminderNote()[state]
  if (note) return <p className="text-xs text-ink-faint">{note}</p>

  const toggle = async () => {
    setBusy(true)
    try {
      setState(state === 'on' ? await disableReminders() : await enableReminders())
    } catch {
      setState(await reminderState().catch(() => 'off' as const))
    } finally {
      setBusy(false)
    }
  }
  return (
    <label className="flex items-center gap-1.5 text-sm text-ink-soft">
      <input
        type="checkbox"
        data-testid="meeting-reminders"
        checked={state === 'on'}
        disabled={busy}
        onChange={() => void toggle()}
      />
      Remind me a minute before
    </label>
  )
}

const STATE_LABEL: Record<MeetingState, string> = {
  recording: 'Recording',
  paused: 'Paused',
  stopped: 'Stopped',
  saved: 'Saved',
}

/** A meeting still open on the server (left running, or its save failed): Resume or Stop. */
function UnsavedRow({ session, now }: { session: MeetingSession; now: number }) {
  const navigate = useNavigate()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = new Date(session.startedAt)
  const day = dayLabel(started, new Date(now))

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      // The controller (and its audio code) loads only when a meeting is stopped from here.
      const { stopSession } = await import('./live/controller')
      const saved = await stopSession(session.id)
      navigate(meetingUrl(saved.space, saved.path), { state: { enhance: true } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The meeting didn’t stop. Try again.')
      setStopping(false)
    }
  }

  return (
    <li
      data-testid="open-session"
      data-session-id={session.id}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-ember/40 bg-ember-wash px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{session.title}</p>
        <p className="truncate text-sm text-ink-soft">
          {STATE_LABEL[session.state]} · started {day === 'Today' ? '' : `${day}, `}
          {timeLabel(started)}
        </p>
      </div>
      <Link
        to={`/meetings/live/${encodeURIComponent(session.id)}`}
        data-testid="open-session-resume"
        className={`${secondaryButton} h-9 px-3`}
      >
        Resume
      </Link>
      <button
        type="button"
        data-testid="open-session-stop"
        onClick={() => void stop()}
        disabled={stopping}
        className={`${primaryButton} h-9 px-3`}
      >
        {stopping ? 'Saving…' : 'Stop'}
      </button>
      {error ? (
        <p role="alert" className="w-full text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </li>
  )
}

function EventRow({ event, now }: { event: CalendarEvent; now: number }) {
  const session = useSession()
  const start = Date.parse(event.start)
  const soon = start - now < SOON_MS
  const others = event.attendees.filter((a) => a.email !== session.me?.principal.email)
  const minutes = Math.max(0, Math.ceil((start - now) / 60_000))
  return (
    <li
      data-testid="calendar-event"
      data-event-id={event.id}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 ${
        soon ? 'border-ember/40 bg-ember-wash' : 'border-ash bg-paper-raised/60'
      }`}
    >
      <div className="w-16 shrink-0 text-sm sm:w-24">
        <span className="block font-medium text-ink tabular-nums">
          {timeLabel(new Date(event.start))}
        </span>
        <span className={`block text-xs ${soon ? 'text-ember-strong' : 'text-ink-faint'}`}>
          {start <= now ? 'Now' : soon ? `In ${minutes} min` : timeLabel(new Date(event.end))}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{event.title}</p>
        <p className="truncate text-sm text-ink-soft">
          {others.length > 0
            ? others.map((a) => a.name ?? attendeeName(a.email)).join(', ')
            : 'Just you'}
          {event.meetLink ? (
            <>
              {' · '}
              <a href={event.meetLink} target="_blank" rel="noreferrer" className="underline">
                Meet link
              </a>
            </>
          ) : null}
        </p>
      </div>
      <Link
        to={`/meetings/start?event=${encodeURIComponent(event.id)}`}
        data-testid="take-notes"
        className={
          soon
            ? `${primaryButton} h-9 px-3`
            : 'inline-flex h-9 items-center rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember'
        }
      >
        Take notes
      </Link>
    </li>
  )
}

/** Person, company and folder options come from the meetings themselves. */
function Filters({
  filters,
  onChange,
}: {
  filters: MeetingFilters
  onChange: (next: MeetingFilters) => void
}) {
  const all = useMeetingList({})
  const session = useSession()
  const options = useMemo(() => {
    const people = new Map<string, string>()
    const companies = new Set<string>()
    const folders = new Set<string>()
    for (const m of all.meetings) {
      for (const a of m.attendees) {
        const email = /<([^>]+)>/.exec(a)?.[1] ?? a
        if (email !== session.me?.principal.email) people.set(email, attendeeName(a))
      }
      for (const c of m.companies) companies.add(c)
      // A folder is a directory under meetings/ above the year/month ones.
      const folder = m.path.slice(0, m.path.lastIndexOf('/')).replace(/\/\d{4}\/\d{2}$/, '')
      if (folder.startsWith('meetings/')) folders.add(folder)
    }
    return {
      people: [...people].sort((a, b) => a[1].localeCompare(b[1])),
      companies: [...companies].sort(),
      folders: [...folders].sort(),
    }
  }, [all.meetings, session.me])

  const set = (key: keyof MeetingFilters, value: string) => {
    const next = { ...filters }
    if (value) next[key] = value
    else delete next[key]
    onChange(next)
  }

  const select = 'h-8 rounded-lg border border-ash bg-paper-raised px-2 text-sm text-ink'
  return (
    <div className="flex flex-wrap gap-2">
      <select
        aria-label="Space"
        value={filters.space ?? ''}
        onChange={(e) => set('space', e.target.value)}
        className={select}
      >
        <option value="">All spaces</option>
        {session.spaces.map((s) => (
          <option key={s.name} value={s.name}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Person"
        value={filters.person ?? ''}
        onChange={(e) => set('person', e.target.value)}
        className={select}
      >
        <option value="">Anyone</option>
        {options.people.map(([email, name]) => (
          <option key={email} value={email}>
            {name}
          </option>
        ))}
      </select>
      {options.companies.length > 0 ? (
        <select
          aria-label="Company"
          value={filters.company ?? ''}
          onChange={(e) => set('company', e.target.value)}
          className={select}
        >
          <option value="">Any company</option>
          {options.companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : null}
      {options.folders.length > 0 ? (
        <select
          aria-label="Folder"
          value={filters.folder ?? ''}
          onChange={(e) => set('folder', e.target.value)}
          className={select}
        >
          <option value="">Every folder</option>
          {options.folders.map((f) => (
            <option key={f} value={f}>
              {f.slice('meetings/'.length)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  )
}

function MeetingList({
  list,
  status,
  error,
  now,
}: {
  list: MeetingSummary[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  now: number
}) {
  const session = useSession()
  const dated = list.filter((m) => m.date)
  return (
    <div data-testid="meeting-list" aria-busy={status === 'loading'} className="mt-4">
      {status === 'error' ? <p className="text-sm text-ember-strong">{error}</p> : null}
      {status === 'ready' && list.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No meetings here yet. Notes you take land in your personal space.
        </p>
      ) : null}
      {groupByDay(dated, (m) => new Date(m.date)).map((group) => (
        <div key={dayKey(group.day)} className="mt-5 first:mt-0">
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {dayLabel(group.day, new Date(now))}
          </h3>
          <ul className="divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/50">
            {group.items.map((m) => (
              <li key={`${m.space}:${m.path}`}>
                <Link
                  to={meetingUrl(m.space, m.path)}
                  data-testid="meeting-item"
                  data-path={m.path}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-paper-raised"
                >
                  <span className="w-16 shrink-0 text-sm text-ink-faint tabular-nums">
                    {timeLabel(new Date(m.date))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{m.title}</span>
                    <span className="block truncate text-sm text-ink-soft">
                      {m.attendees.map(attendeeName).join(', ') || 'No attendees'}
                      {m.duration_min !== null ? ` · ${m.duration_min} min` : ''}
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-2 text-xs text-ink-faint sm:flex">
                    {m.hasTranscript ? <Icon name="transcript" className="size-3.5" /> : null}
                    {session.spaceLabel(m.space)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
