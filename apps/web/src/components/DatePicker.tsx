import { addDays, addMonths, monthGrid, WEEK_DAY_NAMES } from '@hearth/format'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

// Hotsauce's own date picker (docs/PLAN-monday-weeks.md). The browser's built-in one can't be
// told which day starts the week, so this one always shows Monday first and Sunday last.
// Values are `YYYY-MM-DD`, or '' for no date.

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The computer's own date today, `YYYY-MM-DD`. */
function localToday(): string {
  return new Date().toLocaleDateString('en-CA')
}

const asUtc = (date: string) => new Date(`${date}T00:00:00Z`)

/** "Fri, Nov 14, 2026". */
export function dateLabel(date: string): string {
  return asUtc(date).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const monthLabel = (month: string) =>
  asUtc(`${month}-01`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  })

const fullLabel = (date: string) =>
  asUtc(date).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

export function DatePicker({
  value,
  onChange,
  label,
  id,
  testId,
  className = '',
  placeholder = 'No date',
  today: todayProp,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  /** The accessible name of the button, e.g. "Due date". */
  label: string
  id?: string
  testId?: string
  /** Classes for the button, so it matches the form it sits in. */
  className?: string
  placeholder?: string
  /** "Today" in the member's own time zone; the computer's date when not given. */
  today?: string
  disabled?: boolean
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const picked = ISO.test(value) ? value : ''
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        data-testid={testId}
        data-value={picked}
        // With an id, the page's own <label> names the button (keeping its required marker), and
        // the date is read as its description; without one, the label is spoken with the date.
        aria-label={id ? undefined : picked ? `${label}: ${fullLabel(picked)}` : label}
        aria-describedby={id ? `${id}-value` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 text-left ${className}`}
      >
        <Icon name="calendar" className="size-4 shrink-0 text-ink-faint" />
        <span
          id={id ? `${id}-value` : undefined}
          className={`min-w-0 flex-1 truncate ${picked ? '' : 'text-ink-faint'}`}
        >
          {picked ? dateLabel(picked) : placeholder}
        </span>
      </button>
      {open && button.current ? (
        <Calendar
          anchor={button.current}
          value={picked}
          today={todayProp ?? localToday()}
          label={label}
          onPick={(date) => {
            onChange(date)
            setOpen(false)
            button.current?.focus()
          }}
          onClose={() => {
            setOpen(false)
            button.current?.focus()
          }}
          onLeave={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function Calendar({
  anchor,
  value,
  today,
  label,
  onPick,
  onClose,
  onLeave,
}: {
  anchor: HTMLElement
  value: string
  today: string
  label: string
  onPick: (date: string) => void
  /** Escape: close and give focus back to the button. */
  onClose: () => void
  /** Focus or a tap went elsewhere, or the page moved: close and leave focus where it is. */
  onLeave: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The day with keyboard focus; the month shown is the one it's in.
  const [focused, setFocused] = useState(value || today)
  const [moved, setMoved] = useState(false)
  // Focus follows the day only on opening and with the arrow keys; the month buttons keep it.
  const focusDay = useRef(true)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const onLeaveRef = useRef(onLeave)
  onLeaveRef.current = onLeave
  const month = focused.slice(0, 7)
  const weeks = monthGrid(month)
  // Five or six rows: the height changes, so the position is worked out again.
  const rowCount = weeks.length

  // Below the button, kept on screen (above it when there's no room below).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || rowCount === 0) return
    const a = anchor.getBoundingClientRect()
    const { width, height } = el.getBoundingClientRect()
    const below = a.bottom + 4
    const y = below + height > window.innerHeight - 8 ? a.top - height - 4 : below
    setPosition({
      x: Math.max(8, Math.min(a.left, window.innerWidth - width - 8)),
      y: Math.max(8, y),
    })
  }, [anchor, rowCount])

  useEffect(() => {
    if (!focusDay.current) return
    ref.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus()
  }, [focused])

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor.contains(target)) return
      // The tap only closes the calendar: it mustn't also press what's under it (a sheet's
      // backdrop would close the whole task).
      const swallow = (click: MouseEvent) => {
        click.preventDefault()
        click.stopPropagation()
      }
      document.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500)
      onLeaveRef.current()
    }
    // It sits where the button was; if the page under it scrolls or resizes, it closes.
    const onMove = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onLeaveRef.current()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [anchor])

  const step = (date: string, keyboard: boolean) => {
    focusDay.current = keyboard
    setMoved(true)
    setFocused(date)
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Choose ${label.toLowerCase()}`}
      data-testid="date-picker"
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 w-72 rounded-lg border border-ash bg-paper-raised p-3 shadow-float"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && !ref.current?.contains(next) && !anchor.contains(next)) onLeave()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
          return
        }
        const days = KEY_STEPS[event.key]
        const onDay = (event.target as HTMLElement).dataset.date
        if (days !== undefined && onDay) {
          event.preventDefault()
          step(addDays(onDay, days), true)
        }
      }}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          data-testid="date-picker-prev"
          onClick={() => step(addMonths(`${month}-01`, -1), false)}
          className="grid size-8 place-items-center rounded-md text-ink-soft hover:bg-ember-wash"
        >
          <Icon name="back" />
        </button>
        <p
          className="flex-1 text-center text-sm font-semibold text-ink"
          aria-live={moved ? 'polite' : undefined}
          data-testid="date-picker-month"
        >
          {monthLabel(month)}
        </p>
        <button
          type="button"
          aria-label="Next month"
          data-testid="date-picker-next"
          onClick={() => step(addMonths(`${month}-01`, 1), false)}
          className="grid size-8 place-items-center rounded-md text-ink-soft hover:bg-ember-wash"
        >
          <Icon name="chevron" />
        </button>
      </div>
      <table className="mt-2 w-full border-collapse text-center text-sm">
        <thead>
          <tr>
            {WEEK_DAY_NAMES.map((d) => (
              <th
                key={d}
                scope="col"
                abbr={d}
                className="pb-1 text-[0.7rem] font-semibold tracking-wide text-ink-faint uppercase"
              >
                {d.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => {
                const inMonth = date.slice(0, 7) === month
                const selected = date === value
                const isToday = date === today
                return (
                  <td key={date} className="p-0.5">
                    <button
                      type="button"
                      data-date={date}
                      aria-label={fullLabel(date)}
                      aria-pressed={selected}
                      aria-current={isToday ? 'date' : undefined}
                      tabIndex={date === focused ? 0 : -1}
                      onClick={() => onPick(date)}
                      className={`size-8 rounded-md text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-ember ${
                        selected
                          ? 'bg-ember font-semibold text-paper-raised'
                          : isToday
                            ? 'font-semibold text-ember-strong ring-1 ring-ember/50 hover:bg-ember-wash'
                            : inMonth
                              ? 'text-ink hover:bg-ember-wash'
                              : 'text-ink-faint/60 hover:bg-ember-wash'
                      }`}
                    >
                      {Number(date.slice(8, 10))}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between border-t border-ash pt-2 text-sm">
        <button
          type="button"
          data-testid="date-picker-today"
          onClick={() => onPick(today)}
          className="rounded-md px-2 py-1 font-medium text-ember-strong hover:bg-ember-wash"
        >
          Today
        </button>
        {value ? (
          <button
            type="button"
            data-testid="date-picker-clear"
            onClick={() => onPick('')}
            className="rounded-md px-2 py-1 text-ink-soft hover:bg-ember-wash"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
