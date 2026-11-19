import {
  BREAK_ANIMATIONS,
  type BreakAnimation,
  DEFAULT_WORKING_HOURS,
  type WorkingHours,
} from '@hotsauce/format'
import { useEffect } from 'react'
import { secondaryButton } from '../apps/meetings/components/common'
import { ANIMATION_LABELS, BreakScene } from './BreakScene'
import { breaks } from './breaks'
import { lengthLabel, loadBreakSettings, saveBreakSettings } from './settings'
import { useBreakSettings } from './useBreakSettings'

// Settings → General → Breaks (docs/PLAN-breaks.md B9): yours, so the Mac app and every browser
// follow the same settings.

/** The intervals offered: the 20-20-20 rule first, then the usual Pomodoro-ish ones. */
export const EVERY_CHOICES = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120]
export const LENGTH_CHOICES = [10, 20, 30, 60, 120, 300, 600, 900]
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const field =
  'h-9 rounded-lg border border-ash bg-paper-raised px-2 text-sm text-ink focus:border-ember focus:outline-none'

export function BreaksSettings() {
  const { settings, error } = useBreakSettings()
  useEffect(() => {
    void loadBreakSettings()
  }, [])
  const every = EVERY_CHOICES.includes(settings.everyMinutes)
    ? EVERY_CHOICES
    : [...EVERY_CHOICES, settings.everyMinutes].sort((a, b) => a - b)
  const lengths = LENGTH_CHOICES.includes(settings.lengthSeconds)
    ? LENGTH_CHOICES
    : [...LENGTH_CHOICES, settings.lengthSeconds].sort((a, b) => a - b)
  const hours = settings.hours
  const setHours = (change: Partial<WorkingHours>) =>
    void saveBreakSettings({ hours: { ...(hours ?? DEFAULT_WORKING_HOURS), ...change } })

  return (
    <section
      id="breaks"
      aria-labelledby="breaks-title"
      data-testid="settings-breaks"
      className="mt-12 scroll-mt-6"
    >
      <h2 id="breaks-title" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Breaks
      </h2>
      <p className="mt-2 text-ink-soft">
        A gentle reminder to look away from the screen now and then. It waits while you record,
        dictate, share your screen or are in a meeting, and time away from the computer counts as a
        break. Your settings follow you to the Mac app and every browser.
      </p>

      <label className="mt-4 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4">
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">Remind me to take breaks</span>
          <span className="block text-sm text-ink-soft">
            {settings.on
              ? `Every ${settings.everyMinutes} minutes, for ${lengthLabel(settings.lengthSeconds)}.`
              : 'Off.'}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={settings.on}
          data-testid="breaks-on"
          checked={settings.on}
          onChange={(e) => void saveBreakSettings({ on: e.currentTarget.checked })}
          className="size-5 accent-ember"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}

      <fieldset
        disabled={!settings.on}
        data-testid="breaks-details"
        className="mt-4 grid gap-4 disabled:opacity-60"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink">
          <label className="flex items-center gap-2">
            Every
            <select
              data-testid="breaks-every"
              value={settings.everyMinutes}
              onChange={(e) => void saveBreakSettings({ everyMinutes: Number(e.target.value) })}
              className={field}
            >
              {every.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            for
            <select
              data-testid="breaks-length"
              value={settings.lengthSeconds}
              onChange={(e) => void saveBreakSettings({ lengthSeconds: Number(e.target.value) })}
              className={field}
            >
              {lengths.map((s) => (
                <option key={s} value={s}>
                  {lengthLabel(s)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div role="radiogroup" aria-label="Animation" className="grid grid-cols-3 gap-3">
          {BREAK_ANIMATIONS.map((a: BreakAnimation) => (
            <label
              key={a}
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-ash p-3 text-sm text-ink has-[:checked]:border-ember has-[:checked]:bg-ember-wash/40"
            >
              <BreakScene animation={a} className="size-16" />
              <span className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="break-animation"
                  value={a}
                  data-testid={`breaks-animation-${a}`}
                  checked={settings.animation === a}
                  onChange={() => void saveBreakSettings({ animation: a })}
                  className="accent-ember"
                />
                {ANIMATION_LABELS[a]}
              </span>
            </label>
          ))}
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            data-testid="breaks-chime"
            checked={settings.chime}
            onChange={(e) => void saveBreakSettings({ chime: e.currentTarget.checked })}
            className="mt-1 size-4 accent-ember"
          />
          <span>
            <span className="block font-medium text-ink">Chime when the break ends</span>
            <span className="block text-sm text-ink-soft">A soft two-note sound.</span>
          </span>
        </label>

        <div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              data-testid="breaks-hours"
              checked={hours !== null}
              onChange={(e) =>
                void saveBreakSettings({
                  hours: e.currentTarget.checked ? DEFAULT_WORKING_HOURS : null,
                })
              }
              className="mt-1 size-4 accent-ember"
            />
            <span>
              <span className="block font-medium text-ink">Only during working hours</span>
              <span className="block text-sm text-ink-soft">
                No breaks outside these hours, in your own time zone.
              </span>
            </span>
          </label>
          {hours ? (
            <div className="mt-3 ml-7 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink">
              <label className="flex items-center gap-2">
                From
                <input
                  type="time"
                  data-testid="breaks-hours-start"
                  value={hours.start}
                  onChange={(e) =>
                    e.target.value && e.target.value !== hours.end
                      ? setHours({ start: e.target.value })
                      : undefined
                  }
                  className={field}
                />
              </label>
              <label className="flex items-center gap-2">
                to
                <input
                  type="time"
                  data-testid="breaks-hours-end"
                  value={hours.end}
                  onChange={(e) =>
                    e.target.value && e.target.value !== hours.start
                      ? setHours({ end: e.target.value })
                      : undefined
                  }
                  className={field}
                />
              </label>
              <fieldset className="flex gap-1">
                <legend className="sr-only">Days</legend>
                {DAY_NAMES.map((name, day) => {
                  const on = hours.days.includes(day)
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      // The last day stays: no days would mean no breaks at all.
                      disabled={on && hours.days.length === 1}
                      data-testid={`breaks-day-${day}`}
                      onClick={() =>
                        setHours({
                          days: on ? hours.days.filter((d) => d !== day) : [...hours.days, day],
                        })
                      }
                      className={`h-8 rounded-full px-2.5 text-xs font-medium ${
                        on
                          ? 'bg-ember text-paper'
                          : 'border border-ash text-ink-soft hover:text-ink'
                      } disabled:cursor-not-allowed`}
                    >
                      {name}
                    </button>
                  )
                })}
              </fieldset>
            </div>
          ) : null}
        </div>

        <div>
          <button
            type="button"
            data-testid="breaks-now"
            onClick={() => breaks().startNow()}
            className={secondaryButton}
          >
            Take a break now
          </button>
        </div>
      </fieldset>
    </section>
  )
}
