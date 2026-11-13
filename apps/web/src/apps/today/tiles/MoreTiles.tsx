// Tiles a member can add to Today (ARCHITECTURE §16.4, plan T1–T5). Each loads its own data, so
// one that fails leaves the rest of Today alone.

import type { TodayTile } from '@hearth/format'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { type BoardSummary, type BoardView, boardsApi } from '../../../api/boards'
import { calendarApi } from '../../../api/calendar'
import { type DriveFile, filesApi } from '../../../api/files'
import {
  type PersonSummary,
  peopleApi,
  displayName as personName,
  personUrl,
} from '../../../api/people'
import { type TaskView, tasksApi } from '../../../api/tasks'
import type { CalendarEvent } from '../../../api/types'
import { Icon, type IconName } from '../../../components/Icon'
import { boardUrl, displayName, fileUrl } from '../../../lib/paths'
import { useSession } from '../../../state/session'
import { formatWhen } from '../../clips/format'
import { timeLabel } from '../../meetings/format'
import { Card, Empty } from './Card'

/** Lists in tiles stop here; the app itself has the rest. */
export const TILE_LIST_LIMIT = 8

type Loaded<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'done'; value: T }

/**
 * Loads per `key`, and again quietly (keeping what's shown) whenever `refresh` changes, so these
 * tiles stay as current as the rest of Today.
 */
function useLoad<T>(load: () => Promise<T>, key: string, refresh = 0): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ kind: 'loading' })
  const shownKey = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` reads
  useEffect(() => {
    let cancelled = false
    if (shownKey.current !== key) setState({ kind: 'loading' })
    load().then(
      (value) => {
        if (cancelled) return
        shownKey.current = key
        setState({ kind: 'done', value })
      },
      () => {
        // A failed refresh keeps the last good answer.
        if (!cancelled && shownKey.current !== key) setState({ kind: 'error' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, refresh])
  return state
}

function Loading<T>({
  state,
  failed,
  children,
}: {
  state: Loaded<T>
  failed: string
  children: (value: T) => ReactNode
}) {
  if (state.kind === 'loading') return <Empty>Loading…</Empty>
  if (state.kind === 'error') return <Empty>{failed}</Empty>
  return <>{children(state.value)}</>
}

const allLink = (to: string, label: string) => (
  <Link to={to} className="text-xs text-ink-soft hover:text-ink">
    {label}
  </Link>
)

const rowLink = 'min-w-0 flex-1 truncate text-sm text-ink hover:underline'

export function BriefTile() {
  return (
    <Card title="Agent brief" icon="sparkle" testId="today-brief">
      <p className="text-sm text-ink-soft">
        What you're working on, written from your meetings and tasks.{' '}
        <Link to="/meetings/brief" className="text-ember-strong underline">
          Read your brief
        </Link>
      </p>
    </Card>
  )
}

/** T1. */
export function StarredTile() {
  const { stars } = useSession()
  return (
    <Card title="Starred" icon="star" testId="today-starred">
      {stars.length === 0 ? (
        <Empty>Star a doc with ☆ at the top of its page and it shows up here.</Empty>
      ) : (
        <ul className="flex flex-col">
          {stars.slice(0, TILE_LIST_LIMIT * 2).map((s) => (
            <li key={`${s.space}/${s.path}`} className="flex items-center gap-2 py-1">
              <Icon name="star" className="size-3.5 shrink-0 text-ember" />
              <Link
                to={fileUrl(s.space, s.path)}
                className={rowLink}
                data-testid="today-starred-item"
              >
                {s.title ?? displayName(s.path)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Shortcut({
  title,
  icon,
  testId,
  to,
  label,
  hint,
}: {
  title: string
  icon: IconName
  testId: string
  to: string
  label: string
  hint: string
}) {
  return (
    <Card title={title} icon={icon} testId={testId}>
      <Link
        to={to}
        data-testid={`${testId}-go`}
        className="flex items-center gap-3 rounded-xl border border-ash px-3 py-3 hover:border-ember hover:bg-ember-wash"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ember text-paper-raised">
          <Icon name={icon} className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{label}</span>
          <span className="block text-xs text-ink-faint">{hint}</span>
        </span>
      </Link>
    </Card>
  )
}

/** T2. */
export function DictateTile() {
  return (
    <Shortcut
      title="Dictate"
      icon="mic"
      testId="today-dictate"
      to="/dictate"
      label="Start dictating"
      hint="Talk, and it’s written down for you."
    />
  )
}

/** T2. */
export function ClipTile() {
  return (
    <Shortcut
      title="Record a clip"
      icon="video"
      testId="today-clip"
      to="/clips/new"
      label="Record a clip"
      hint="Your screen and voice, to share with a link."
    />
  )
}

/** T3. */
export function PeopleTile({ refresh }: { refresh: number }) {
  const state = useLoad(async () => (await peopleApi.list()).people, 'people', refresh)
  return (
    <Card
      title="People"
      icon="people"
      testId="today-people"
      action={allLink('/people', 'All people')}
    >
      <Loading state={state} failed="People didn’t load.">
        {(people: PersonSummary[]) =>
          people.length === 0 ? (
            <Empty>No one yet. People show up once you’ve met with them.</Empty>
          ) : (
            <ul className="flex flex-col">
              {people.slice(0, TILE_LIST_LIMIT).map((p) => (
                <li key={p.email} className="flex items-center gap-3 py-1">
                  <Link to={personUrl(p.email)} className={rowLink} data-testid="today-person">
                    {personName(p)}
                  </Link>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {p.next ? `Next: ${p.next.title}` : (p.company ?? '')}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
    </Card>
  )
}

/** T3. */
export function FilesTile({ now, refresh }: { now: Date; refresh: number }) {
  const state = useLoad(() => filesApi.recent(), 'files', refresh)
  return (
    <Card
      title="Recent files"
      icon="folder"
      testId="today-files"
      action={allLink('/files', 'All files')}
    >
      <Loading state={state} failed="Files didn’t load.">
        {(files: DriveFile[]) =>
          files.length === 0 ? (
            <Empty>No files yet.</Empty>
          ) : (
            <ul className="flex flex-col">
              {files.slice(0, TILE_LIST_LIMIT).map((f) => (
                <li key={`${f.space}/${f.id}`} className="flex items-center gap-3 py-1">
                  <Link to={f.url} className={rowLink} data-testid="today-file">
                    {f.name}
                  </Link>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {formatWhen(f.updatedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Loading>
    </Card>
  )
}

/** T4: one board, chosen per tile. */
export function BoardTile({
  tile,
  now,
  refresh,
  onChoose,
}: {
  tile: TodayTile
  now: Date
  refresh: number
  onChoose: (board: { space: string; id: string }) => void
}) {
  const board = tile.board
  return (
    <Card
      title="Board"
      icon="board"
      testId="today-board"
      action={board ? allLink('/boards', 'All boards') : undefined}
    >
      {board ? (
        <BoardPreview board={board} now={now} refresh={refresh} />
      ) : (
        <BoardPicker onChoose={onChoose} />
      )}
    </Card>
  )
}

function BoardPreview({
  board,
  now,
  refresh,
}: {
  board: { space: string; id: string }
  now: Date
  refresh: number
}) {
  const state = useLoad(
    () => boardsApi.get(board.space, board.id),
    `${board.space}/${board.id}`,
    refresh,
  )
  return (
    <Loading state={state} failed="That board didn’t load. It may have been deleted.">
      {(b: BoardView) => (
        <Link
          to={boardUrl(b.space, b.path)}
          data-testid="today-board-open"
          className="block rounded-xl border border-ash px-3 py-3 hover:border-ember"
        >
          <span className="block truncate font-medium text-ink">{b.title}</span>
          <span className="block text-xs text-ink-faint">Changed {formatWhen(b.updated, now)}</span>
          {b.texts.length > 0 ? (
            <span className="mt-2 line-clamp-3 block text-sm text-ink-soft">
              {b.texts.slice(0, 12).join(' · ')}
            </span>
          ) : null}
        </Link>
      )}
    </Loading>
  )
}

/** E4: a new Board tile asks which board. */
function BoardPicker({ onChoose }: { onChoose: (board: { space: string; id: string }) => void }) {
  const state = useLoad(() => boardsApi.list(), 'boards')
  return (
    <Loading state={state} failed="Boards didn’t load.">
      {(boards: BoardSummary[]) =>
        boards.length === 0 ? (
          <Empty>
            No boards yet.{' '}
            <Link to="/boards" className="text-ember-strong underline">
              Draw one
            </Link>
          </Empty>
        ) : (
          <label className="block text-sm text-ink-soft">
            Which board?
            <select
              data-testid="today-board-choose"
              defaultValue=""
              onChange={(e) => {
                const b = boards.find((x) => `${x.space}/${x.id}` === e.target.value)
                if (b) onChoose({ space: b.space, id: b.id })
              }}
              className="mt-1 block h-10 w-full rounded-lg border border-ash bg-paper px-2 text-sm text-ink"
            >
              <option value="" disabled>
                Choose a board
              </option>
              {boards.map((b) => (
                <option key={`${b.space}/${b.id}`} value={`${b.space}/${b.id}`}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
        )
      }
    </Loading>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Monday to Sunday around `now`, in the member's own time. */
export function weekDays(now: Date): Date[] {
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - ((now.getDay() + 6) % 7),
  )
  return Array.from(
    { length: 7 },
    (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
  )
}

interface WeekData {
  events: CalendarEvent[]
  tasks: TaskView[]
}

/** T5: this week, Monday to Sunday, with meetings and due tasks. */
export function WeekTile({ now, refresh }: { now: Date; refresh: number }) {
  const days = weekDays(now)
  const first = days[0] as Date
  const last = days[6] as Date
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
  const today = isoDate(now)
  const [picked, setPicked] = useState(today)
  // Past midnight, the new day is the one shown.
  useEffect(() => setPicked(today), [today])
  const state = useLoad<WeekData>(
    async () => {
      const [events, tasks] = await Promise.all([
        calendarApi.upcoming({ from: first.toISOString(), to: end.toISOString() }).catch(() => []),
        tasksApi.list({
          status: 'open',
          mine: true,
          dueAfter: isoDate(first),
          dueBefore: isoDate(last),
        }),
      ])
      return { events, tasks }
    },
    isoDate(first),
    refresh,
  )

  const on = (date: string, data: WeekData) => ({
    events: data.events
      .filter((e) => isoDate(new Date(e.start)) === date)
      .sort((a, b) => a.start.localeCompare(b.start)),
    tasks: data.tasks.filter((t) => t.due?.slice(0, 10) === date),
  })

  return (
    <Card
      title="This week"
      icon="calendar"
      testId="today-week"
      action={allLink('/meetings', 'Meetings')}
    >
      <Loading state={state} failed="This week didn’t load.">
        {(data: WeekData) => {
          const chosen = on(picked, data)
          return (
            <>
              <div className="grid grid-cols-7 gap-1">
                {days.map((d) => {
                  const date = isoDate(d)
                  const items = on(date, data)
                  const count = items.events.length + items.tasks.length
                  return (
                    <button
                      key={date}
                      type="button"
                      onClick={() => setPicked(date)}
                      aria-pressed={picked === date}
                      aria-label={`${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}: ${
                        count === 0 ? 'nothing on' : count === 1 ? '1 item' : `${count} items`
                      }`}
                      data-testid="today-week-day"
                      data-date={date}
                      className={`flex flex-col items-center rounded-lg py-1.5 text-xs ${
                        picked === date
                          ? 'bg-ember-wash text-ink'
                          : 'text-ink-soft hover:bg-paper-sunk'
                      } ${date === today ? 'font-semibold text-ember-strong' : ''}`}
                    >
                      <span>{d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
                      <span className="text-sm tabular-nums">{d.getDate()}</span>
                      <span
                        className="mt-0.5 h-1.5 text-[10px] leading-none text-ember"
                        aria-hidden="true"
                      >
                        {count > 0 ? '•'.repeat(Math.min(count, 3)) : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
              <ul className="mt-3 flex flex-col gap-1" data-testid="today-week-items">
                {chosen.events.length + chosen.tasks.length === 0 ? (
                  <li>
                    <Empty>Nothing on {picked === today ? 'today' : 'this day'}.</Empty>
                  </li>
                ) : null}
                {chosen.events.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 text-xs text-ink-faint tabular-nums">
                      {timeLabel(new Date(e.start))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">{e.title}</span>
                  </li>
                ))}
                {chosen.tasks.map((t) => (
                  <li key={`${t.space}/${t.id}`} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 text-xs text-ink-faint">Task</span>
                    <Link to={fileUrl(t.space, t.path)} className={rowLink}>
                      {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )
        }}
      </Loading>
    </Card>
  )
}
