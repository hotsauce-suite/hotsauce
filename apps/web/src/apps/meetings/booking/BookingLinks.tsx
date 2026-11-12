import { useCallback, useEffect, useState } from 'react'
import {
  type BookingInput,
  type BookingLink,
  type BookingStatus,
  bookingApi,
  bookingUrl,
  type Hours,
  slugify,
  type Weekday,
} from '../../../api/booking'
import { HearthApiError } from '../../../api/client'
import { useAuthState } from '../../../auth/AuthContext'
import { product } from '../../../brand/product'
import { Icon } from '../../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../components/common'

// Meetings → Booking links (ARCHITECTURE §19): the member's personal booking links. Each is a
// file in their personal space; the public page is /book/<handle>/<slug>.

const DAYS: Array<{ key: Weekday; label: string }> = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]
const LENGTHS = [15, 30, 45, 60]
const BUFFERS = [0, 5, 10, 15, 30]
const NOTICE = [
  { minutes: 0, label: 'No minimum' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 2880, label: '2 days' },
]
const HORIZONS = [7, 14, 30, 60, 90]
const NINE_TO_FIVE: Array<[string, string]> = [['09:00', '17:00']]

function blankLink(): BookingInput {
  return {
    title: '',
    minutes: 30,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hours: {
      sun: [],
      mon: NINE_TO_FIVE,
      tue: NINE_TO_FIVE,
      wed: NINE_TO_FIVE,
      thu: NINE_TO_FIVE,
      fri: NINE_TO_FIVE,
      sat: [],
    },
    bufferBefore: 0,
    bufferAfter: 0,
    noticeMinutes: 240,
    horizonDays: 30,
    dailyCap: null,
    questions: [],
    description: '',
    active: true,
    blobOid: null,
  }
}

function zones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return all.includes(current) ? all : [current, ...all]
}

function errorText(err: unknown): string {
  return err instanceof HearthApiError || err instanceof Error
    ? err.message
    : 'Something went wrong.'
}

type Editing = { slug: string | null; draft: BookingInput } | null

/** `/meetings/booking`. */
export default function BookingLinks() {
  const [status, setStatus] = useState<BookingStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await bookingApi.status())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    document.title = `Booking links · ${product()} Meetings`
    void load()
  }, [load])

  return (
    <>
      <MeetingsPageHeader title="Booking links" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28 md:px-8 md:pt-10">
          <h1 className="font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink">
            Booking links
          </h1>
          <p className="mt-2 text-[0.95rem] text-ink-soft">
            Share a link and people pick a time when you’re free. Hearth checks your Google
            Calendar, adds the meeting with a Google Meet link, and Google emails you both the
            invite. Their answers show up in the meeting.
          </p>

          {error ? (
            <p role="alert" className="mt-5 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
          {status === null && !error ? (
            <p className="mt-6 text-sm text-ink-soft">Loading…</p>
          ) : null}

          {status && !status.ready ? <TurnOn /> : null}

          {status?.ready && !status.canTakeBookings ? (
            <p
              data-testid="booking-not-taking"
              className="mt-5 rounded-xl border border-ash bg-paper-raised p-4 text-sm text-ink-soft"
            >
              You can set links up now. Booking pages start taking bookings once your {product()}{' '}
              admin finishes turning on the robot check.
            </p>
          ) : null}

          {status?.ready ? (
            <>
              <ul className="mt-6 space-y-3" data-testid="booking-links">
                {status.links.map((l) =>
                  editing?.slug === l.slug ? null : (
                    <LinkCard
                      key={l.slug}
                      link={l}
                      handle={status.handle}
                      onEdit={() => setEditing({ slug: l.slug, draft: { ...l } })}
                      onDeleted={load}
                    />
                  ),
                )}
              </ul>
              {status.links.length === 0 && !editing ? (
                <p className="mt-2 text-sm text-ink-soft">No links yet.</p>
              ) : null}
              {editing ? (
                <LinkEditor
                  key={editing.slug ?? 'new'}
                  slug={editing.slug}
                  initial={editing.draft}
                  taken={status.links.map((l) => l.slug)}
                  onCancel={() => setEditing(null)}
                  onSaved={async () => {
                    setEditing(null)
                    await load()
                  }}
                />
              ) : (
                <button
                  type="button"
                  data-testid="booking-new"
                  className={`${primaryButton} mt-5`}
                  onClick={() => setEditing({ slug: null, draft: blankLink() })}
                >
                  <Icon name="plus" />
                  New booking link
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

function TurnOn() {
  const { signOut } = useAuthState()
  return (
    <div
      data-testid="booking-turn-on"
      className="mt-6 rounded-xl border border-ash bg-paper-raised p-4"
    >
      <p className="font-medium text-ink">Turn on booking links</p>
      <p className="mt-1 text-sm text-ink-soft">
        {product()} needs permission to add events to your Google Calendar. Sign out, sign back in
        with Google, and allow calendar access when Google asks.
      </p>
      <p className="mt-2 text-sm text-ink-soft">
        If Google doesn’t ask, your {product()} admin hasn’t turned booking links on yet.
      </p>
      <button
        type="button"
        data-testid="booking-sign-out"
        className={`${secondaryButton} mt-3 h-9`}
        onClick={signOut}
      >
        Sign out
      </button>
    </div>
  )
}

function describe(l: BookingLink): string {
  const days = DAYS.filter((d) => l.hours[d.key].length > 0).map((d) => d.label.slice(0, 3))
  return `${l.minutes} min · ${days.join(', ') || 'no days'} · ${l.tz}`
}

function LinkCard({
  link,
  handle,
  onEdit,
  onDeleted,
}: {
  link: BookingLink
  handle: string
  onEdit: () => void
  onDeleted: () => Promise<void>
}) {
  const url = bookingUrl(handle, link.slug)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  return (
    <li
      data-testid="booking-link"
      data-slug={link.slug}
      className="rounded-xl border border-ash bg-paper-raised p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            {link.title}
            {link.active ? null : (
              <span className="ml-2 rounded bg-ash/60 px-1.5 py-0.5 text-xs text-ink-soft">
                Off
              </span>
            )}
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">{describe(link)}</p>
          <p className="mt-1 truncate text-sm text-ink-faint" data-testid="booking-url">
            {url}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="booking-copy"
          className={`${secondaryButton} h-9`}
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          <Icon name="copy" />
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="booking-open"
          className={`${secondaryButton} h-9`}
        >
          <Icon name="external" />
          Open
        </a>
        <button
          type="button"
          data-testid="booking-edit"
          className={`${secondaryButton} h-9`}
          onClick={onEdit}
        >
          <Icon name="pencil" />
          Edit
        </button>
        <button
          type="button"
          data-testid="booking-delete"
          disabled={deleting}
          className={`${secondaryButton} h-9`}
          onClick={async () => {
            if (!window.confirm(`Delete “${link.title}”? Its link stops working.`)) return
            setDeleting(true)
            try {
              await bookingApi.remove(link.slug, link.blobOid)
              await onDeleted()
            } catch (err) {
              setError(errorText(err))
              setDeleting(false)
            }
          }}
        >
          <Icon name="trash" />
          Delete
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </li>
  )
}

const field = 'mt-1 h-9 w-full rounded-lg border border-ash-strong bg-paper px-2 text-sm text-ink'
const label = 'block text-sm font-medium text-ink'

function LinkEditor({
  slug,
  initial,
  taken,
  onCancel,
  onSaved,
}: {
  slug: string | null
  initial: BookingInput
  taken: string[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<BookingInput>(initial)
  const [name, setName] = useState(slug ?? '')
  const [nameTouched, setNameTouched] = useState(slug !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof BookingInput>(key: K, value: BookingInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const linkName = slug ?? (nameTouched ? name : slugify(draft.title))
  const setDay = (day: Weekday, windows: Array<[string, string]>) =>
    set('hours', { ...draft.hours, [day]: windows } as Hours)

  const save = async () => {
    if (!draft.title.trim()) return setError('Give the link a title.')
    if (slug === null && taken.includes(linkName)) {
      return setError(`You already have a link named ${linkName}. Choose another name.`)
    }
    setBusy(true)
    setError(null)
    try {
      await bookingApi.save(linkName, draft)
      await onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <form
      data-testid="booking-editor"
      className="mt-6 space-y-5 rounded-xl border border-ash bg-paper-raised p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <p className="font-medium text-ink">{slug ? 'Edit booking link' : 'New booking link'}</p>
      <label className={label}>
        Title
        <input
          data-testid="booking-title"
          className={field}
          value={draft.title}
          maxLength={120}
          placeholder="Intro call"
          onChange={(e) => set('title', e.target.value)}
        />
      </label>
      <label className={label}>
        Link name
        <input
          data-testid="booking-slug"
          className={`${field} disabled:opacity-60`}
          value={linkName}
          disabled={slug !== null}
          maxLength={50}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
          }}
        />
        <span className="mt-1 block text-xs font-normal text-ink-faint">
          {slug ? 'A link’s name can’t change.' : 'Lowercase letters, numbers and dashes.'}
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Length
          <select
            data-testid="booking-minutes"
            className={field}
            value={draft.minutes}
            onChange={(e) => set('minutes', Number(e.target.value))}
          >
            {LENGTHS.map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Time zone
          <select
            data-testid="booking-tz"
            className={field}
            value={draft.tz}
            onChange={(e) => set('tz', e.target.value)}
          >
            {zones(draft.tz).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset>
        <legend className={label}>When you take meetings</legend>
        <div className="mt-2 space-y-2">
          {DAYS.map(({ key, label: dayLabel }) => {
            const windows = draft.hours[key]
            const on = windows.length > 0
            return (
              <div key={key} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex w-32 items-center gap-2 text-ink">
                  <input
                    type="checkbox"
                    data-testid={`booking-day-${key}`}
                    checked={on}
                    onChange={(e) => setDay(key, e.target.checked ? NINE_TO_FIVE : [])}
                  />
                  {dayLabel}
                </label>
                {on ? (
                  windows.map(([from, to], i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with no identity of their own
                    <span key={`${key}-${i}`} className="flex items-center gap-1">
                      <input
                        type="time"
                        aria-label={`${dayLabel} from`}
                        className="h-8 rounded border border-ash-strong bg-paper px-1"
                        value={from}
                        onChange={(e) =>
                          setDay(
                            key,
                            windows.map((w, j) => (j === i ? [e.target.value, w[1]] : w)),
                          )
                        }
                      />
                      –
                      <input
                        type="time"
                        aria-label={`${dayLabel} until`}
                        className="h-8 rounded border border-ash-strong bg-paper px-1"
                        value={to}
                        onChange={(e) =>
                          setDay(
                            key,
                            windows.map((w, j) => (j === i ? [w[0], e.target.value] : w)),
                          )
                        }
                      />
                      {windows.length > 1 ? (
                        <button
                          type="button"
                          aria-label={`Remove ${dayLabel} hours`}
                          className="px-1 text-ink-faint hover:text-ink"
                          onClick={() =>
                            setDay(
                              key,
                              windows.filter((_, j) => j !== i),
                            )
                          }
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))
                ) : (
                  <span className="text-ink-faint">Not available</span>
                )}
                {on && windows.length < 4 ? (
                  <button
                    type="button"
                    className="text-xs text-ember-strong hover:underline"
                    onClick={() => setDay(key, [...windows, ['13:00', '17:00']])}
                  >
                    Add hours
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Free time before
          <select
            className={field}
            value={draft.bufferBefore}
            onChange={(e) => set('bufferBefore', Number(e.target.value))}
          >
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'None' : `${m} minutes`}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Free time after
          <select
            className={field}
            value={draft.bufferAfter}
            onChange={(e) => set('bufferAfter', Number(e.target.value))}
          >
            {BUFFERS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'None' : `${m} minutes`}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Book at least this far ahead
          <select
            data-testid="booking-notice"
            className={field}
            value={draft.noticeMinutes}
            onChange={(e) => set('noticeMinutes', Number(e.target.value))}
          >
            {(NOTICE.some((n) => n.minutes === draft.noticeMinutes)
              ? NOTICE
              : [
                  ...NOTICE,
                  { minutes: draft.noticeMinutes, label: `${draft.noticeMinutes} minutes` },
                ]
            ).map((n) => (
              <option key={n.minutes} value={n.minutes}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Up to this far ahead
          <select
            className={field}
            value={draft.horizonDays}
            onChange={(e) => set('horizonDays', Number(e.target.value))}
          >
            {(HORIZONS.includes(draft.horizonDays)
              ? HORIZONS
              : [...HORIZONS, draft.horizonDays].sort((a, b) => a - b)
            ).map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Most bookings a day
          <select
            className={field}
            value={draft.dailyCap ?? 0}
            onChange={(e) => set('dailyCap', Number(e.target.value) || null)}
          >
            <option value={0}>No limit</option>
            {Array.from({ length: Math.max(10, draft.dailyCap ?? 0) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={label}>
        Description <span className="font-normal text-ink-faint">(optional)</span>
        <textarea
          className="mt-1 w-full rounded-lg border border-ash-strong bg-paper p-2 text-sm text-ink"
          rows={2}
          maxLength={1000}
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </label>

      <fieldset>
        <legend className={label}>
          Questions for the person booking{' '}
          <span className="font-normal text-ink-faint">(up to 3, optional)</span>
        </legend>
        <div className="mt-1 space-y-2">
          {draft.questions.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with no identity of their own
            <div key={`q-${i}`} className="flex gap-2">
              <input
                data-testid="booking-question"
                className={field.replace('mt-1 ', '')}
                value={q}
                maxLength={200}
                onChange={(e) =>
                  set(
                    'questions',
                    draft.questions.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
              />
              <button
                type="button"
                aria-label="Remove question"
                className="px-2 text-ink-faint hover:text-ink"
                onClick={() =>
                  set(
                    'questions',
                    draft.questions.filter((_, j) => j !== i),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          {draft.questions.length < 3 ? (
            <button
              type="button"
              data-testid="booking-add-question"
              className="text-sm text-ember-strong hover:underline"
              onClick={() => set('questions', [...draft.questions, ''])}
            >
              Add a question
            </button>
          ) : null}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          data-testid="booking-active"
          checked={draft.active}
          onChange={(e) => set('active', e.target.checked)}
        />
        Taking bookings (turn off to pause the link)
      </label>

      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" data-testid="booking-save" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
