import { useEffect, useState } from 'react'
import type { CheckinInput, Weekday } from '../../api/checkins'
import { type ChatRoom, formsApi } from '../../api/forms'
import { inputClass } from '../../routes/org/fields'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { WEEKDAY_ORDER, WEEKDAY_SHORT } from './format'

/** The question, its schedule, the chat room, and (once it exists) who isn't asked. */
export function CheckinForm({
  initial,
  people,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: CheckinInput
  /** Everyone a saved check-in could ask; absent while creating. */
  people?: Array<{ email: string; name: string }>
  submitLabel: string
  busy: boolean
  onSubmit: (input: CheckinInput) => void
  onCancel: () => void
  extra?: React.ReactNode
}) {
  const [input, setInput] = useState<CheckinInput>(initial)
  const [rooms, setRooms] = useState<ChatRoom[]>([])
  useEffect(() => {
    formsApi.rooms().then(
      (r) => setRooms(r.rooms),
      () => setRooms([]),
    )
  }, [])
  const toggleDay = (d: Weekday) =>
    setInput((i) => ({
      ...i,
      days: i.days.includes(d) ? i.days.filter((x) => x !== d) : [...i.days, d],
    }))
  const toggleSkip = (email: string) =>
    setInput((i) => ({
      ...i,
      skip: i.skip.includes(email) ? i.skip.filter((x) => x !== email) : [...i.skip, email],
    }))
  const everyone = [
    ...(people ?? []),
    ...input.skip
      .filter((e) => !people?.some((p) => p.email === e))
      .map((email) => ({ email, name: email })),
  ]

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(input)
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Question</span>
        <input
          className={inputClass}
          value={input.title}
          maxLength={300}
          required
          data-testid="checkin-question"
          onChange={(e) => setInput({ ...input, title: e.target.value })}
        />
      </label>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium text-ink">Asked on</legend>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={input.days.includes(d)}
              data-testid={`checkin-day-${d}`}
              onClick={() => toggleDay(d)}
              className={`rounded-full border px-3 py-1 ${
                input.days.includes(d)
                  ? 'border-ember bg-ember-wash text-ink'
                  : 'border-ash text-ink-soft hover:bg-paper-sunk'
              }`}
            >
              {WEEKDAY_SHORT[d]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="flex flex-col gap-1 text-sm sm:w-40">
          <span className="font-medium text-ink">At</span>
          <input
            type="time"
            className={inputClass}
            value={input.time}
            required
            data-testid="checkin-time"
            onChange={(e) => setInput({ ...input, time: e.target.value })}
          />
          <span className="text-xs text-ink-faint">In each person’s own time zone</span>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Summary goes to</span>
          <select
            className={inputClass}
            value={input.room ?? ''}
            data-testid="checkin-room"
            onChange={(e) => setInput({ ...input, room: e.target.value || null })}
          >
            <option value="">No chat room</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-faint">
            One summary once everyone has answered, or at 5 PM. Admins add rooms in Settings →
            Organization.
          </span>
        </label>
      </div>
      {people ? (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 font-medium text-ink">Who is asked</legend>
          <ul className="grid gap-1 sm:grid-cols-2">
            {everyone.map((p) => (
              <li key={p.email}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!input.skip.includes(p.email)}
                    onChange={() => toggleSkip(p.email)}
                    data-testid={`checkin-ask-${p.email}`}
                  />
                  <span className="truncate text-ink">{p.name}</span>
                  <span className="truncate text-xs text-ink-faint">{p.email}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {people ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={input.paused}
            data-testid="checkin-paused"
            onChange={(e) => setInput({ ...input, paused: e.target.checked })}
          />
          <span className="text-ink">Paused: don’t ask until I turn it back on</span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || input.days.length === 0 || !input.title.trim()}
          data-testid="checkin-save"
        >
          {submitLabel}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
        {extra}
      </div>
    </form>
  )
}
