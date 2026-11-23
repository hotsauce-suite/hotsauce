import { useCallback, useEffect, useRef, useState } from 'react'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import {
  actOnDictation,
  DICTATION_RANGES,
  DICTATIONS_CHANGED,
  type DictationRange,
  type MacDictations as Dictations,
  type MacDictation,
  readMacDictations,
  SEARCH_LIMIT,
} from '../../lib/macDictations'
import { type MacSettingsBridge, macSettingsBridge } from '../../lib/macSettings'
import { secondaryButton } from '../meetings/components/common'

const card = 'rounded-xl border border-ash bg-paper-raised/60 p-4'
const smallButton = `${secondaryButton} h-8 px-3`

/** Five shades for the month grid, none to the busiest day (MonthActivity.level). */
const LEVELS = ['bg-paper-sunk', 'bg-ember/15', 'bg-ember/35', 'bg-ember/60', 'bg-ember'] as const

/**
 * The Dictate page's "On this Mac" (docs/PLAN-dictations-page.md R1–R5, R9): this Mac's numbers and
 * recent dictations, read from the Mac app. Nothing at all in a browser, or in an app that doesn't
 * answer.
 */
export function MacDictations({
  bridge = macSettingsBridge(),
}: {
  bridge?: MacSettingsBridge | null
}) {
  const [range, setRange] = useState<DictationRange>('month')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<(Dictations & { query: string }) | null>(null)
  const [absent, setAbsent] = useState(bridge === null)
  const asked = useRef(0)
  const loaded = useRef(false)

  const read = useCallback(async () => {
    if (!bridge) return
    const n = ++asked.current
    const reply = await readMacDictations(range, search, bridge)
    // Only the newest question's answer: typing fast mustn't show an older search.
    if (n !== asked.current) return
    if (reply) {
      loaded.current = true
      setAbsent(false)
      setData({ ...reply, query: search })
    } else if (!loaded.current) {
      // An app that doesn't answer has no such section; a later answer brings it back.
      setAbsent(true)
    }
  }, [bridge, range, search])

  useEffect(() => {
    const t = window.setTimeout(() => void read(), search ? 150 : 0)
    return () => window.clearTimeout(t)
  }, [read, search])

  // Again when the window comes back to the front, and when the Mac's history changes (R5).
  useEffect(() => {
    const again = () => void read()
    window.addEventListener('focus', again)
    window.addEventListener(DICTATIONS_CHANGED, again)
    return () => {
      window.removeEventListener('focus', again)
      window.removeEventListener(DICTATIONS_CHANGED, again)
    }
  }, [read])

  if (absent || !bridge) return null

  return (
    <section
      id="dictations"
      aria-labelledby="dictations-title"
      data-testid="mac-dictations"
      className="mb-14 scroll-mt-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            id="dictations-title"
            className="font-display text-xl font-semibold tracking-tight text-ink"
          >
            On this Mac
          </h3>
          <p className="mt-1 max-w-[38rem] text-sm text-ink-soft">
            What you’ve dictated on this Mac. It stays here: {product()} doesn’t keep it.
          </p>
        </div>
        <fieldset className="inline-flex rounded-lg border border-ash-strong p-0.5">
          <legend className="sr-only">Count</legend>
          {DICTATION_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`h-8 rounded-md px-3 text-sm ${
                range === r.id ? 'bg-ember text-paper-raised' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </fieldset>
      </div>

      {data ? (
        <Loaded data={data} search={search} setSearch={setSearch} bridge={bridge} />
      ) : (
        <p className="mt-4 text-sm text-ink-faint" role="status">
          Loading…
        </p>
      )}
    </section>
  )
}

function Loaded({
  data,
  search,
  setSearch,
  bridge,
}: {
  data: Dictations & { query: string }
  search: string
  setSearch: (s: string) => void
  bridge: MacSettingsBridge
}) {
  const { stats } = data
  const [open, setOpen] = useRecentOpen()
  const most = Math.max(1, stats.topApps[0]?.words ?? 1)
  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-3" data-testid="mac-dictations-tiles">
        <Tile
          title="Total words"
          value={stats.totalWords.toLocaleString()}
          detail={`${stats.dictations.toLocaleString()} ${stats.dictations === 1 ? 'dictation' : 'dictations'}`}
        />
        <Tile
          title="Time saved"
          value={duration(stats.timeSavedMinutes)}
          detail="vs typing at 40 wpm"
        />
        <Tile title="Average speed" value={`${stats.averageWPM} wpm`} detail="while speaking" />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_17rem]">
        <div className={card} data-testid="mac-dictations-sources">
          <h4 className="font-display text-base font-semibold text-ink">Top sources</h4>
          {stats.topApps.length === 0 ? (
            <p className="mt-3 text-sm text-ink-faint">Apps you dictate into show up here.</p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {stats.topApps.map((app) => (
                <li key={app.bundle ?? app.name} className="flex items-center gap-2.5">
                  <AppIcon url={app.bundle ? data.icons[app.bundle] : undefined} size="size-5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium text-ink">{app.name}</span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {app.words.toLocaleString()} words
                      </span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-paper-sunk">
                      <div
                        className="h-1 rounded-full bg-ember/75"
                        style={{ width: `${Math.max(2, (app.words / most) * 100)}%` }}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <MonthGrid month={data.month} />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-display text-base font-semibold text-ink">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mac-dictations-recent"
            onClick={() => setOpen(!open)}
            className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 hover:text-ember"
          >
            <Icon
              name="chevron"
              className={`size-3.5 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
            />
            Recent dictations
          </button>
        </h4>
        {open ? (
          <input
            type="search"
            value={search}
            maxLength={SEARCH_LIMIT}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search dictations"
            className="h-9 w-full rounded-lg border border-ash-strong bg-paper-raised px-3 text-sm sm:w-56"
          />
        ) : null}
      </div>
      {open ? (
        <div id="mac-dictations-recent">
          {data.records.length === 0 ? (
            <p className="mt-3 text-sm text-ink-faint" data-testid="mac-dictations-empty">
              {data.total === 0
                ? 'Hold your dictation shortcut anywhere and speak. Your dictations stay on this Mac.'
                : `Nothing matches “${data.query.trim()}”.`}
            </p>
          ) : (
            <ul className="mt-3 space-y-2" data-testid="mac-dictations-list">
              {data.records.map((record) => (
                <Row
                  key={record.id}
                  record={record}
                  icon={record.bundle ? data.icons[record.bundle] : undefined}
                  bridge={bridge}
                />
              ))}
            </ul>
          )}
          {data.matched > data.records.length ? (
            <p className="mt-2 text-xs text-ink-faint">
              The newest {data.records.length} of {data.matched.toLocaleString()}. Search to find
              older ones.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** Whether Recent dictations is open; remembered on this device (R10). Open until closed. */
export const RECENT_KEY = 'hotsauce:dictate-recent'

function useRecentOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(RECENT_KEY) !== 'closed'
    } catch {
      return true
    }
  })
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    try {
      if (next) localStorage.removeItem(RECENT_KEY)
      else localStorage.setItem(RECENT_KEY, 'closed')
    } catch {
      // No storage (private window): it lasts until the page reloads.
    }
  }, [])
  return [open, setOpen]
}

function Tile({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className={card}>
      <p className="text-[0.7rem] font-semibold tracking-wide text-ink-faint uppercase">{title}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink">{value}</p>
      <p className="text-xs text-ink-soft">{detail}</p>
    </div>
  )
}

function MonthGrid({ month }: { month: Dictations['month'] }) {
  const start = new Date(month.start)
  const name = start.toLocaleDateString(undefined, { month: 'long' })
  return (
    <div className={card} data-testid="mac-dictations-month">
      <h4 className="font-display text-base font-semibold text-ink">{name}</h4>
      <div className="mt-3 grid w-max grid-cols-7 gap-1" aria-hidden="true">
        {monthCells(month, start).map((cell) =>
          cell.kind === 'weekday' ? (
            <span key={cell.id} className="text-center text-[0.6rem] font-semibold text-ink-faint">
              {cell.label}
            </span>
          ) : cell.kind === 'blank' ? (
            <span key={cell.id} />
          ) : (
            <span
              key={cell.id}
              title={cell.title}
              className={`flex h-5 w-6 items-center justify-center rounded text-[0.5rem] ${cell.level >= 3 ? 'text-paper-raised/80' : 'text-ink-faint/70'} ${LEVELS[cell.level]}`}
            >
              {cell.label}
            </span>
          ),
        )}
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        {month.activeDays} active {month.activeDays === 1 ? 'day' : 'days'}
      </p>
    </div>
  )
}

type Cell =
  | { kind: 'weekday'; id: string; label: string }
  | { kind: 'blank'; id: string }
  | { kind: 'day'; id: string; label: string; title: string; level: 0 | 1 | 2 | 3 | 4 }

/** The grid's cells, each with its own id: weekday names repeat (T, S). */
function monthCells(month: Dictations['month'], start: Date): Cell[] {
  const cells: Cell[] = []
  // Monday first, as Hotsauce's weeks run (docs/PLAN-monday-weeks.md); 2024-01-01 was a Monday.
  for (let i = 0; i < 7; i++) {
    const label = new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' })
    cells.push({ kind: 'weekday', id: `w${i}`, label })
  }
  for (let i = 0; i < month.leadingBlanks; i++) cells.push({ kind: 'blank', id: `b${i}` })
  month.days.forEach((day, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), i + 1)
    const when = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    cells.push({
      kind: 'day',
      id: `d${i + 1}`,
      label: String(i + 1),
      title: `${when}: ${day.words} words`,
      level: day.level,
    })
  })
  return cells
}

function Row({
  record,
  icon,
  bridge,
}: {
  record: MacDictation
  icon: string | undefined
  bridge: MacSettingsBridge
}) {
  const [done, setDone] = useState<'copy' | 'paste' | 'failed' | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const act = async (action: 'copy' | 'paste') => {
    const ok = await actOnDictation(record.id, action, bridge)
    setDone(ok ? action : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setDone(null), 2000)
  }

  const app = record.app ?? 'Unknown app'
  return (
    <li className={`${card} flex items-start gap-3`}>
      <AppIcon url={icon} size="size-7" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-sm font-semibold text-ink">{app}</span>
          <span className="text-ink-faint">{relative(record.date)}</span>
          {record.onDevice ? (
            <Tag title="Written up by this Mac’s own speech recognition: with no connection, or because you chose On this Mac only">
              on this Mac
            </Tag>
          ) : !record.cleaned ? (
            <Tag>as spoken</Tag>
          ) : null}
        </p>
        <p className="mt-1 line-clamp-5 text-sm whitespace-pre-line text-ink">{record.text}</p>
        {done === 'failed' ? (
          <p role="alert" className="mt-1 text-xs text-ember-strong">
            The Mac couldn’t do that. It may have been cleared.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          className={smallButton}
          aria-label={`Copy dictation from ${app}`}
          onClick={() => void act('copy')}
        >
          <Icon name="copy" />
          {done === 'copy' ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className={smallButton}
          aria-label={`Paste dictation from ${app}`}
          title="Paste into the app you were in before this window"
          onClick={() => void act('paste')}
        >
          Paste
        </button>
      </div>
    </li>
  )
}

function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded-full bg-paper-sunk px-2 py-px text-[0.65rem] font-medium text-ink-faint"
    >
      {children}
    </span>
  )
}

function AppIcon({ url, size }: { url: string | undefined; size: string }) {
  if (url) return <img src={url} alt="" className={`${size} shrink-0`} />
  return <span aria-hidden="true" className={`${size} shrink-0 rounded-md bg-paper-sunk`} />
}

export function duration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} s`
  if (minutes < 60) return `${Math.round(minutes)} min`
  return `${(minutes / 60).toFixed(1)} h`
}

function relative(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
