import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import type { MeetingActionItems } from '../../api/types'
import { hearthSocket } from '../../api/ws'
import { meetingUrl } from '../../lib/paths'

/** How many items show before "Show all". */
const COLLAPSED = 6
const REFETCH_DEBOUNCE_MS = 2_000

interface Row {
  key: string
  space: string
  path: string
  title: string
  line: number
  text: string
}

function rowsOf(meetings: MeetingActionItems[]): Row[] {
  return meetings.flatMap((m) =>
    m.items.map((item) => ({
      key: `${m.space}:${m.path}:${item.line}`,
      space: m.space,
      path: m.path,
      title: m.title,
      line: item.line,
      text: item.text,
    })),
  )
}

/** `GET /api/meetings/action-items`, refetched when a commit touches `meetings/`. */
function useActionItems(): { rows: Row[]; setRows: (update: (rows: Row[]) => Row[]) => void } {
  const [rows, setRows] = useState<Row[]>([])
  const [version, setVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refetch trigger.
  useEffect(() => {
    let cancelled = false
    meetingsApi.actionItems().then(
      (list) => {
        if (!cancelled && Array.isArray(list)) setRows(rowsOf(list))
      },
      // A convenience on the home page: if it can't load, the section stays hidden.
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [version])

  // Each refetch reads up to 60 notes on the server; a burst of saves refetches once.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = hearthSocket.onChanged((event) => {
      if (!event.paths.some((p) => p.startsWith('meetings/'))) return
      clearTimeout(timer)
      timer = setTimeout(() => setVersion((v) => v + 1), REFETCH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [])

  return { rows, setRows }
}

/** Meetings home: the open `- [ ]` items from the member's meetings, each tickable in place. */
export function ActionItems() {
  const { rows, setRows } = useActionItems()
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (rows.length === 0 && !error) return null
  const shown = expanded ? rows : rows.slice(0, COLLAPSED)

  const complete = async (row: Row) => {
    setError(null)
    setRows((current) => current.filter((r) => r.key !== row.key))
    try {
      await meetingsApi.completeActionItem({
        space: row.space,
        path: row.path,
        line: row.line,
        text: row.text,
      })
    } catch (err) {
      setRows((current) => (current.some((r) => r.key === row.key) ? current : [row, ...current]))
      setError(
        err instanceof HearthApiError
          ? err.message
          : 'That didn’t save. Check your connection and try again.',
      )
    }
  }

  return (
    <section aria-labelledby="action-items" data-testid="action-items" className="mt-12">
      <h2 id="action-items" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Open action items
      </h2>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <ul className="mt-4 divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/50">
        {shown.map((row) => (
          <li key={row.key} data-testid="action-item" className="flex items-start gap-3 px-4 py-3">
            <input
              type="checkbox"
              aria-label={`Mark done: ${row.text}`}
              onChange={() => void complete(row)}
              className="mt-1 size-4 shrink-0 accent-ember"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-ink">{row.text}</span>
              <Link
                to={`${meetingUrl(row.space, row.path)}#L${row.line}`}
                className="block truncate text-sm text-ink-soft hover:text-ink"
              >
                {row.title}
              </Link>
            </span>
          </li>
        ))}
      </ul>
      {rows.length > COLLAPSED ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-sm text-ink-soft hover:text-ink"
        >
          {expanded ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </section>
  )
}
