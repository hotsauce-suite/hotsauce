import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { type Booked, bookingApi, type PublicBookingPage, type Slot } from '../../../api/booking'
import { HearthApiError } from '../../../api/client'
import { product } from '../../../brand/product'
import { Icon } from '../../../components/Icon'
import {
  DEV_TURNSTILE_TOKEN as DEV_TOKEN,
  TurnstileWidget,
} from '../../../components/TurnstileWidget'
import { primaryButton, secondaryButton } from '../components/common'

// The signed-out booking page, /book/<handle>/<slug> (ARCHITECTURE §19): open times in the
// booker's own time zone, then name, email, the link's questions and the robot check.

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Local midnight on the Monday that starts the week of `ms`: weeks run Monday to Sunday. */
export function startOfLocalWeek(ms: number): number {
  const d = new Date(ms)
  return addDays(startOfLocalDay(ms), -((d.getDay() + 6) % 7))
}

/** Local midnight `n` days on, whatever the clock changes do in between. */
function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function errorText(err: unknown): string {
  return err instanceof HearthApiError || err instanceof Error
    ? err.message
    : 'Something went wrong.'
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA')
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** `/book/:handle/:slug`. */
export default function BookPage() {
  const { handle = '', slug = '' } = useParams()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [weekStart, setWeekStart] = useState(() => startOfLocalWeek(Date.now()))
  const [page, setPage] = useState<PublicBookingPage | null>(null)
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
  const [booked, setBooked] = useState<Booked | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // On a first visit late in the week (a Sunday evening, say) nothing may be left this week:
  // then the page opens on next week instead, once per link, if next week has times.
  const advanced = useRef('')

  const load = useCallback(async () => {
    const from = new Date(Math.max(weekStart, Date.now())).toISOString()
    const to = new Date(addDays(weekStart, 7)).toISOString()
    try {
      const p = await bookingApi.page(handle, slug, from, to)
      const link = `${handle}/${slug}`
      if (advanced.current !== link) {
        advanced.current = link
        if (p.slots.length === 0 && p.canTakeBookings) {
          const next = await bookingApi.page(
            handle,
            slug,
            new Date(addDays(weekStart, 7)).toISOString(),
            new Date(addDays(weekStart, 14)).toISOString(),
          )
          if (next.slots.length > 0) {
            setWeekStart(addDays(weekStart, 7))
            return
          }
        }
      }
      setPage(p)
      setLoadError(null)
      setDay((current) =>
        current && p.slots.some((s) => dayKey(s.start) === current)
          ? current
          : p.slots[0]
            ? dayKey(p.slots[0].start)
            : null,
      )
    } catch (err) {
      setLoadError({
        status: err instanceof HearthApiError ? err.status : 0,
        message: errorText(err),
      })
    }
  }, [handle, slug, weekStart])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    document.title = page ? `${page.title} · ${page.ownerName}` : `Book a time · ${product()}`
  }, [page])

  const days = useMemo(() => {
    const byDay = new Map<string, Slot[]>()
    for (const s of page?.slots ?? []) {
      const k = dayKey(s.start)
      byDay.set(k, [...(byDay.get(k) ?? []), s])
    }
    return [...byDay.entries()]
  }, [page])
  const times = days.find(([k]) => k === day)?.[1] ?? []

  if (loadError && !page) {
    return (
      <Frame>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {loadError.status === 404 ? 'This booking link doesn’t exist' : 'Booking isn’t available'}
        </h1>
        <p className="mt-2 text-ink-soft" data-testid="book-error">
          {loadError.status === 404
            ? 'Check the link you were sent, or ask the person who shared it for a new one.'
            : loadError.message}
        </p>
      </Frame>
    )
  }
  if (!page) {
    return (
      <Frame>
        <p className="text-ink-soft">Loading…</p>
      </Frame>
    )
  }

  if (booked) {
    return (
      <Frame>
        <div data-testid="book-done">
          <p className="flex items-center gap-2 text-sm font-medium text-moss">
            <Icon name="check" />
            You’re booked
          </p>
          <h1 className="mt-2 font-display text-2xl font-semibold text-ink">{page.title}</h1>
          <p className="mt-1 text-ink" data-testid="book-done-when">
            {dayLabel(booked.start)}, {timeLabel(booked.start)} to {timeLabel(booked.end)}
          </p>
          <p className="mt-1 text-sm text-ink-soft">with {page.ownerName}</p>
          {booked.meetLink ? (
            <a
              href={booked.meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className={`${secondaryButton} mt-4 h-9`}
            >
              <Icon name="video" />
              Google Meet link
            </a>
          ) : null}
          <p className="mt-4 text-sm text-ink-soft">
            Google Calendar is emailing you the invite. To cancel or move it, use the invite.
          </p>
        </div>
      </Frame>
    )
  }

  const thisWeek = startOfLocalWeek(Date.now())
  return (
    <Frame>
      <p className="text-sm text-ink-soft">{page.ownerName}</p>
      <h1 className="mt-1 font-display text-2xl font-semibold text-ink" data-testid="book-title">
        {page.title}
      </h1>
      <p className="mt-1 flex items-center gap-1 text-sm text-ink-soft">
        <Icon name="video" />
        {page.minutes} minutes, Google Meet
      </p>
      {page.description ? (
        <p className="mt-3 whitespace-pre-line text-[0.95rem] text-ink">{page.description}</p>
      ) : null}
      {!page.canTakeBookings ? (
        <p className="mt-4 rounded-lg bg-ash/40 p-3 text-sm text-ink-soft">
          This page can’t take bookings yet. Please try again later.
        </p>
      ) : null}

      {slot ? (
        <BookingForm
          page={page}
          slot={slot}
          onBack={() => setSlot(null)}
          onBooked={setBooked}
          onTaken={async (message) => {
            setSlot(null)
            setNotice(message)
            await load()
          }}
          book={(input) => bookingApi.book(handle, slug, input)}
        />
      ) : (
        <>
          <div className="mt-6 flex items-center gap-2">
            <button
              type="button"
              aria-label="Earlier week"
              disabled={weekStart <= thisWeek}
              className={`${secondaryButton} h-8 px-2`}
              onClick={() => setWeekStart((w) => Math.max(thisWeek, addDays(w, -7)))}
            >
              <Icon name="back" />
            </button>
            <p
              className="flex-1 text-center text-sm font-medium text-ink"
              data-testid="book-week"
              data-start={new Date(weekStart).toLocaleDateString('en-CA')}
            >
              {new Date(weekStart).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}{' '}
              –{' '}
              {new Date(addDays(weekStart, 6)).toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
              })}
            </p>
            <button
              type="button"
              aria-label="Later week"
              data-testid="book-next-week"
              className={`${secondaryButton} h-8 px-2`}
              onClick={() => setWeekStart((w) => addDays(w, 7))}
            >
              <Icon name="chevron" />
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-ink-faint">
            Times are in {tz.replace(/_/g, ' ')}
          </p>
          {notice ? (
            <p role="alert" className="mt-3 text-sm text-ember-strong" data-testid="book-notice">
              {notice}
            </p>
          ) : null}
          {days.length === 0 ? (
            <p className="mt-6 text-center text-sm text-ink-soft" data-testid="book-no-times">
              No open times this week. Try the next week.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-[11rem_1fr]">
              <ul className="flex gap-2 overflow-x-auto sm:flex-col">
                {days.map(([k, slots]) => (
                  <li key={k} className="shrink-0">
                    <button
                      type="button"
                      data-testid="book-day"
                      aria-pressed={k === day}
                      onClick={() => setDay(k)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${k === day ? 'border-ember bg-ember-wash text-ink' : 'border-ash-strong text-ink hover:border-ember'}`}
                    >
                      {dayLabel(slots[0]?.start ?? k)}
                    </button>
                  </li>
                ))}
              </ul>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Open times">
                {times.map((s) => (
                  <li key={s.start}>
                    <button
                      type="button"
                      data-testid="book-time"
                      data-start={s.start}
                      disabled={!page.canTakeBookings}
                      onClick={() => {
                        setNotice(null)
                        setSlot(s)
                      }}
                      className="h-10 w-full rounded-lg border border-ash-strong text-sm text-ink hover:border-ember disabled:opacity-50"
                    >
                      {timeLabel(s.start)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-paper px-4 py-8 md:py-16">
      <main className="mx-auto w-full max-w-2xl rounded-2xl border border-ash bg-paper-raised p-5 shadow-sm md:p-8">
        {children}
      </main>
      <p className="mt-4 text-center text-xs text-ink-faint">Scheduling by {product()}</p>
    </div>
  )
}

function BookingForm({
  page,
  slot,
  onBack,
  onBooked,
  onTaken,
  book,
}: {
  page: PublicBookingPage
  slot: Slot
  onBack: () => void
  onBooked: (b: Booked) => void
  onTaken: (message: string) => Promise<void>
  book: (input: {
    start: string
    name: string
    email: string
    answers: string[]
    token: string
  }) => Promise<Booked>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [answers, setAnswers] = useState<string[]>(() => page.questions.map(() => ''))
  const [token, setToken] = useState<string | null>(
    page.robotCheck?.kind === 'dev' ? DEV_TOKEN : null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [widgetKey, setWidgetKey] = useState(0)

  const submit = async () => {
    if (!name.trim()) return setError('Add your name.')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Add your email address.')
    if (!token) return setError('Finish the check below first.')
    setBusy(true)
    setError(null)
    try {
      onBooked(await book({ start: slot.start, name, email, answers, token }))
    } catch (err) {
      setBusy(false)
      if (err instanceof HearthApiError && err.status === 409) return onTaken(err.message)
      setError(errorText(err))
      // A Turnstile token works once; the next try needs a new one.
      if (page.robotCheck?.kind === 'turnstile') {
        setToken(null)
        setWidgetKey((k) => k + 1)
      }
    }
  }

  return (
    <form
      data-testid="book-form"
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center gap-2 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
        <Icon name="calendar" />
        <span className="flex-1" data-testid="book-chosen">
          {dayLabel(slot.start)}, {timeLabel(slot.start)} to {timeLabel(slot.end)}
        </span>
        <button type="button" className="text-ember-strong hover:underline" onClick={onBack}>
          Change
        </button>
      </div>
      <label className="block text-sm font-medium text-ink">
        Your name
        <input
          data-testid="book-name"
          autoComplete="name"
          className="mt-1 h-10 w-full rounded-lg border border-ash-strong bg-paper px-3 text-sm text-ink"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block text-sm font-medium text-ink">
        Email
        <input
          data-testid="book-email"
          type="email"
          autoComplete="email"
          className="mt-1 h-10 w-full rounded-lg border border-ash-strong bg-paper px-3 text-sm text-ink"
          value={email}
          maxLength={254}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {page.questions.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the link's questions, in order
        <label key={i} className="block text-sm font-medium text-ink">
          {q}
          <textarea
            data-testid="book-answer"
            rows={2}
            maxLength={2000}
            className="mt-1 w-full rounded-lg border border-ash-strong bg-paper p-2 text-sm text-ink"
            value={answers[i] ?? ''}
            onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
          />
        </label>
      ))}
      {page.robotCheck?.kind === 'turnstile' ? (
        <TurnstileWidget
          key={widgetKey}
          widget={page.robotCheck}
          onToken={setToken}
          testId="book-turnstile"
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="book-submit"
        disabled={busy || !page.canTakeBookings}
        className={`${primaryButton} w-full`}
      >
        {busy ? 'Booking…' : 'Book it'}
      </button>
    </form>
  )
}
