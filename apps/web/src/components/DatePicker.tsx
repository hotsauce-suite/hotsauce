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
        aria-label={picked ? `${label}: ${fullLabel(picked)}` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 text-left ${className}`}
      >
        <Icon name="calendar" className="size-4 shrink-0 text-ink-faint" />
        <span className={`min-w-0 flex-1 truncate ${picked ? '' : 'text-ink-faint'}`}>
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
}: {
  anchor: HTMLElement
  value: string
  today: string
  label: string
  onPick: (date: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The day with keyboard focus; the month shown is the one it's in.
  const [focused, setFocused] = useState(value || today)
  const [moved, setMoved] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const month = focused.slice(0, 7)

  // Below the button, kept on screen (above it when there's no room below).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const { width, height } = el.getBoundingClientRect()
    const below = a.bottom + 4
    const y = below + height > window.innerHeight - 8 ? a.top - height - 4 : below
    setPosition({
      x: Math.max(8, Math.min(a.left, window.innerWidth - width - 8)),
      y: Math.max(8, y),
    })
  }, [anchor])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus()
    // Focus follows the arrow keys; the first focus is the picked day or today.
  }, [focused])

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target)) onCloseRef.current()
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [anchor])

  const step = (date: string) => {
    setMoved(true)
    setFocused(date)
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-testid="date-picker"
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 w-72 rounded-lg border border-ash bg-paper-raised p-3 shadow-float"
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
          step(addDays(onDay, days))
        }
      }}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          data-testid="date-picker-prev"
          onClick={() => step(addMonths(`${month}-01`, -1))}
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
          onClick={() => step(addMonths(`${month}-01`, 1))}
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
          {monthGrid(month).map((week) => (
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
