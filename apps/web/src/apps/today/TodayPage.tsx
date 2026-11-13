import { parseQuickAdd } from '@hearth/format'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { checkinsApi, type DueCheckin } from '../../api/checkins'
import { HearthApiError } from '../../api/client'
import { dictationApi } from '../../api/dictation'
import { memberTimeZone, type TaskView, tasksApi } from '../../api/tasks'
import { type TodayMeeting, type TodayView, todayApi } from '../../api/today'
import { hearthSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Icon, type IconName } from '../../components/Icon'
import { MAC_APP_SETTINGS, useMacAppBuild } from '../../components/MacApp'
import { TOUCH_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { desktopSignInBridge } from '../../lib/desktop'
import { docUrl, fileUrl, meetingUrl, noteUrl } from '../../lib/paths'
import { useSession } from '../../state/session'
import { formatWhen } from '../clips/format'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { attendeeName, timeLabel } from '../meetings/format'
import { PersonLinks } from '../people/PersonLinks'

/** Changes from elsewhere (a task done on the phone, a doc saved) refresh Today this soon. */
const REFRESH_DEBOUNCE_MS = 500
/** Today also refreshes on its own, so "In 5 min" and the calendar stay current. */
const REFRESH_EVERY_MS = 60_000

/** `/today`: the home page. The member's day on one screen, nothing written by AI. */
export default function TodayPage() {
  const [view, setView] = useState<TodayView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())

  // Only the newest request's answer is shown: an older one finishing late would bring back a
  // task completed in between.
  const latest = useRef(0)
  const load = useCallback(async () => {
    const ask = ++latest.current
    try {
      const next = await todayApi.get()
      if (ask !== latest.current) return
      setView(next)
      setError(null)
    } catch (err) {
      if (ask !== latest.current) return
      setError(err instanceof HearthApiError ? err.message : 'Today didn’t load.')
    } finally {
      setNow(new Date())
    }
  }, [])

  useEffect(() => {
    document.title = `${product()} Today`
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS)
    }
    const offChanged = hearthSocket.onChanged(soon)
    const offReconnect = hearthSocket.onReconnect(soon)
    const every = setInterval(() => void load(), REFRESH_EVERY_MS)
    return () => {
      offChanged()
      offReconnect()
      clearInterval(every)
      if (timer) clearTimeout(timer)
    }
  }, [load])

  // Whatever is in flight was asked before these changes: its answer is dropped.
  const removeTask = (task: TaskView) => {
    latest.current++
    setView((v) => (v ? { ...v, tasks: v.tasks.filter((t) => t.id !== task.id) } : v))
  }
  const addTask = (task: TaskView) => {
    latest.current++
    setView((v) => (v ? { ...v, tasks: [...v.tasks, task] } : v))
  }

  return (
    <>
      <MeetingsPageHeader title="Today" menu={false}>
        <span className="hidden text-sm text-ink-soft sm:inline" data-testid="today-date">
          {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="today">
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8">
          {error ? (
            <p role="alert" className="mb-4 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
          {view === null ? (
            error ? null : (
              <p className="text-sm text-ink-faint" data-testid="today-loading">
                Loading your day…
              </p>
            )
          ) : (
            <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
              <div className="flex min-w-0 flex-col gap-5">
                <CheckinsCard />
                <MeetingsCard meetings={view.meetings} now={now} />
                <TasksCard
                  tasks={view.tasks}
                  date={view.date}
                  onDone={removeTask}
                  onAdded={addTask}
                />
                {view.actionItems.length > 0 ? <ActionItemsCard view={view} /> : null}
              </div>
              <div className="flex min-w-0 flex-col gap-5">
                {view.notes.length > 0 ? <NotesCard notes={view.notes} now={now} /> : null}
                <DocsCard docs={view.docs} now={now} />
                <Card title="Agent brief" icon="sparkle" testId="today-brief">
                  <p className="text-sm text-ink-soft">
                    What you're working on, written from your meetings and tasks.{' '}
                    <Link to="/meetings/brief" className="text-ember-strong underline">
                      Read your brief
                    </Link>
                  </p>
                </Card>
                <MacAppCard />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** Check-ins asked of the member that they haven't answered yet (ARCHITECTURE §24.6). */
function CheckinsCard() {
  const [due, setDue] = useState<DueCheckin[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      checkinsApi.due().then(
        (r) => {
          if (!cancelled) setDue(r.due)
        },
        // Today still works without it.
        () => undefined,
      )
    void load()
    const off = hearthSocket.onChanged(() => void load())
    const every = setInterval(() => void load(), REFRESH_EVERY_MS)
    return () => {
      cancelled = true
      off()
      clearInterval(every)
    }
  }, [])
  if (due.length === 0) return null
  return (
    <Card title="Check-in" icon="checklist" testId="today-checkins">
      <ul className="flex flex-col gap-2">
        {due.map((c) => (
          <li key={`${c.id}-${c.date}`}>
            <Link
              to={`/checkins/${c.id}`}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-paper-sunk"
              data-testid="today-checkin"
            >
              <span className="min-w-0 flex-1 text-sm font-medium text-ink">{c.title}</span>
              <span className="shrink-0 text-sm text-ember-strong">Answer</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** This browser remembers that the member closed the Mac app card. */
export const MAC_APP_CARD_DISMISSED = 'hearth.today.macAppCard.dismissed'

function cardDismissed(): boolean {
  try {
    return localStorage.getItem(MAC_APP_CARD_DISMISSED) === '1'
  } catch {
    return false
  }
}

/**
 * "Get the Mac app", until the member has it: not inside the app's own window, not on a phone or
 * tablet, not on a server with no build, not once a Mac is connected, not once closed.
 */
function MacAppCard() {
  const touch = useMediaQuery(TOUCH_QUERY)
  const inApp = desktopSignInBridge() !== null
  const [dismissed, setDismissed] = useState(cardDismissed)
  const relevant = !touch && !inApp && !dismissed
  const hasBuild = useMacAppBuild(relevant)
  const [hasMac, setHasMac] = useState<boolean | null>(null)

  useEffect(() => {
    if (!relevant) return
    let cancelled = false
    dictationApi.devices().then(
      (devices) => {
        if (!cancelled) setHasMac(devices.length > 0)
      },
      // Not knowing is no reason to nag.
      () => {
        if (!cancelled) setHasMac(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [relevant])

  if (!relevant || hasBuild !== true || hasMac !== false) return null
  const dismiss = () => {
    try {
      localStorage.setItem(MAC_APP_CARD_DISMISSED, '1')
    } catch {
      // Hidden for this visit only.
    }
    setDismissed(true)
  }
  return (
    <Card
      title="Get the Mac app"
      icon="download"
      testId="today-mac-app"
      action={
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide the Mac app card"
          data-testid="today-mac-app-dismiss"
          className="rounded-md p-1 text-ink-faint hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      }
    >
      <p className="text-sm text-ink-soft">
        Dictate into any app, record any call and get a nudge before each meeting.{' '}
        <Link
          to={MAC_APP_SETTINGS}
          data-testid="today-mac-app-link"
          className="text-ember-strong underline"
        >
          Download it
        </Link>
      </p>
    </Card>
  )
}

function Card({
  title,
  icon,
  testId,
  action,
  children,
}: {
  title: string
  icon: IconName
  testId: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="rounded-2xl border border-ash bg-paper-raised/60 px-4 py-4 md:px-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} className="size-4 text-ink-faint" />
        <h2 className="flex-1 text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-faint">{children}</p>
}

function MeetingsCard({ meetings, now }: { meetings: TodayView['meetings']; now: Date }) {
  const upcoming = meetings.events.filter((e) => Date.parse(e.end) > now.getTime())
  const done = meetings.events.length - upcoming.length
  return (
    <Card
      title="Meetings"
      icon="calendar"
      testId="today-meetings"
      action={
        <Link to="/meetings" className="text-xs text-ink-soft hover:text-ink">
          All meetings
        </Link>
      }
    >
      {meetings.error ? (
        <p className="text-sm text-ink-soft" data-testid="today-calendar-error">
          {meetings.error}{' '}
          <Link to="/settings" className="text-ember-strong underline">
            Settings
          </Link>
        </p>
      ) : upcoming.length === 0 ? (
        <Empty>{done > 0 ? 'No more meetings today.' : 'No meetings today.'}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {upcoming.map((e) => (
            <MeetingRow key={e.id} event={e} now={now} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function MeetingRow({ event, now }: { event: TodayMeeting; now: Date }) {
  const session = useSession()
  const me = session.me?.principal.email.toLowerCase()
  const start = Date.parse(event.start)
  const minutes = Math.ceil((start - now.getTime()) / 60_000)
  const soon = minutes <= 15
  const others = event.attendees.filter((a) => a.email.toLowerCase() !== me)
  return (
    <li
      data-testid="today-meeting"
      data-event-id={event.id}
      className={`rounded-xl border px-3 py-3 ${soon ? 'border-ember/40 bg-ember-wash' : 'border-ash'}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="w-16 shrink-0 text-sm">
          <span className="block font-medium text-ink tabular-nums">
            {timeLabel(new Date(event.start))}
          </span>
          <span className={`block text-xs ${soon ? 'text-ember-strong' : 'text-ink-faint'}`}>
            {minutes <= 0 ? 'Now' : soon ? `In ${minutes} min` : timeLabel(new Date(event.end))}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{event.title}</p>
          <p className="truncate text-sm text-ink-soft">
            {others.length > 0 ? (
              <PersonLinks
                people={others.map((a) => ({
                  email: a.email.toLowerCase(),
                  name: a.name ?? attendeeName(a.email),
                }))}
                testId="today-attendee"
              />
            ) : (
              'Just you'
            )}
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
        {event.note ? (
          <Link
            to={meetingUrl(event.note.space, event.note.path)}
            data-testid="today-open-notes"
            className="inline-flex h-9 items-center rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember"
          >
            Open notes
          </Link>
        ) : (
          <Link
            to={`/meetings/start?event=${encodeURIComponent(event.id)}`}
            data-testid="today-take-notes"
            className={
              soon
                ? `${primaryButton} h-9 px-3`
                : 'inline-flex h-9 items-center rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember'
            }
          >
            Take notes
          </Link>
        )}
      </div>
      {event.prep ? (
        <p className="mt-2 text-sm text-ink-soft" data-testid="today-prep">
          <span className="font-medium text-ink">Last time</span>{' '}
          <Link to={meetingUrl(event.prep.space, event.prep.path)} className="underline">
            {event.prep.title}
          </Link>
          {event.prep.line ? `: ${event.prep.line}` : null}
        </p>
      ) : null}
    </li>
  )
}

function TasksCard({
  tasks,
  date,
  onDone,
  onAdded,
}: {
  tasks: TaskView[]
  date: string
  onDone: (task: TaskView) => void
  onAdded: (task: TaskView) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overdue = tasks.filter((t) => t.due !== null && t.due.slice(0, 10) < date)
  const due = tasks.filter((t) => !overdue.includes(t))

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const line = text.trim()
    if (!line || busy) return
    setBusy(true)
    setError(null)
    try {
      // Added on Today means due today, unless the line names its own date.
      const dated = parseQuickAdd(line, { today: date }).due !== undefined
      const task = await tasksApi.quick({
        text: dated ? line : `${line} today`,
        tz: memberTimeZone(),
      })
      setText('')
      if (task.mine && task.due !== null && task.due.slice(0, 10) <= date) onAdded(task)
    } catch (err) {
      setError(err instanceof HearthApiError ? err.message : 'That task didn’t save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Tasks"
      icon="tasks"
      testId="today-tasks"
      action={
        <Link to="/tasks" className="text-xs text-ink-soft hover:text-ink">
          All tasks
        </Link>
      }
    >
      <form onSubmit={(e) => void add(e)} className="mb-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task for today"
          aria-label="Add a task for today"
          data-testid="today-quick-add"
          disabled={busy}
          className="h-10 w-full rounded-lg border border-ash bg-paper px-3 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
        />
      </form>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <Empty>Nothing due today.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {overdue.length > 0 ? (
            <TaskGroup label="Overdue" tasks={overdue} onDone={onDone} late />
          ) : null}
          {due.length > 0 ? <TaskGroup label="Due today" tasks={due} onDone={onDone} /> : null}
        </div>
      )}
    </Card>
  )
}

function TaskGroup({
  label,
  tasks,
  onDone,
  late = false,
}: {
  label: string
  tasks: TaskView[]
  onDone: (task: TaskView) => void
  late?: boolean
}) {
  return (
    <div>
      <p className={`mb-1 text-xs font-medium ${late ? 'text-ember-strong' : 'text-ink-faint'}`}>
        {label}
      </p>
      <ul className="flex flex-col">
        {tasks.map((t) => (
          <TaskLine key={`${t.space}/${t.id}`} task={t} onDone={onDone} />
        ))}
      </ul>
    </div>
  )
}

function TaskLine({ task, onDone }: { task: TaskView; onDone: (task: TaskView) => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const complete = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await tasksApi.complete(task.space, task.id, memberTimeZone())
      onDone(task)
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }
  return (
    <li data-testid="today-task" className="flex items-center gap-3 py-1.5">
      <button
        type="button"
        aria-busy={busy}
        aria-label={`Complete “${task.title}”`}
        data-testid="today-task-done"
        disabled={busy}
        onClick={() => void complete()}
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-ash-strong text-paper-raised hover:border-ember disabled:bg-ember"
      >
        {busy ? <Icon name="check" className="size-3" /> : null}
      </button>
      <Link
        to={fileUrl(task.space, task.path)}
        className="min-w-0 flex-1 truncate text-sm text-ink hover:underline"
      >
        {task.title}
      </Link>
      {task.dueAt ? (
        <span className="shrink-0 text-xs text-ink-faint tabular-nums">
          {timeLabel(new Date(task.dueAt))}
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="shrink-0 text-xs text-ember-strong">
          Didn’t save
        </span>
      ) : null}
    </li>
  )
}

function ActionItemsCard({ view }: { view: TodayView }) {
  const count = view.actionItems.reduce((n, m) => n + m.items.length, 0)
  return (
    <Card
      title="From your meetings"
      icon="checklist"
      testId="today-action-items"
      action={
        <Link to="/tasks/today" className="text-xs text-ink-soft hover:text-ink">
          Make tasks
        </Link>
      }
    >
      <p className="mb-2 text-xs text-ink-faint">
        {count === 1 ? '1 to-do' : `${count} to-dos`} from meeting notes that aren’t tasks yet.
      </p>
      <ul className="flex flex-col gap-2">
        {view.actionItems.slice(0, 5).map((m) => (
          <li key={`${m.space}/${m.path}`} className="text-sm">
            <Link to={meetingUrl(m.space, m.path)} className="font-medium text-ink hover:underline">
              {m.title}
            </Link>
            <ul className="mt-0.5 list-disc pl-5 text-ink-soft">
              {m.items.slice(0, 3).map((i) => (
                <li key={i.line}>{i.text}</li>
              ))}
              {m.items.length > 3 ? (
                <li className="text-ink-faint">and {m.items.length - 3} more</li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function NotesCard({ notes, now }: { notes: TodayView['notes']; now: Date }) {
  return (
    <Card
      title="Unfiled notes"
      icon="notes"
      testId="today-notes"
      action={
        <Link to="/notes" className="text-xs text-ink-soft hover:text-ink">
          All notes
        </Link>
      }
    >
      <p className="mb-2 text-xs text-ink-faint">From the last day, not pinned or labelled.</p>
      <ul className="flex flex-col gap-2">
        {notes.map((n) => (
          <li key={`${n.space}/${n.id}`}>
            <Link
              to={noteUrl(n.space, n.path)}
              className="block rounded-lg border border-ash px-3 py-2 hover:border-ember"
            >
              {n.title ? (
                <span className="block truncate text-sm font-medium text-ink">{n.title}</span>
              ) : null}
              <span className="line-clamp-2 text-sm text-ink-soft">{n.body}</span>
              <span className="mt-1 block text-xs text-ink-faint">
                {formatWhen(n.created, now)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function DocsCard({ docs, now }: { docs: TodayView['docs']; now: Date }) {
  return (
    <Card title="Docs changed" icon="docs" testId="today-docs">
      {docs.length === 0 ? (
        <Empty>No docs changed since yesterday.</Empty>
      ) : (
        <ul className="flex flex-col">
          {docs.map((d) => (
            <li key={`${d.space}/${d.path}`} className="flex items-center gap-3 py-1">
              <Link
                to={docUrl(d.space, d.path)}
                className="min-w-0 flex-1 truncate text-sm text-ink hover:underline"
              >
                {d.title}
              </Link>
              <span className="shrink-0 text-xs text-ink-faint">
                {d.team ? 'Team · ' : ''}
                {formatWhen(d.changed, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
