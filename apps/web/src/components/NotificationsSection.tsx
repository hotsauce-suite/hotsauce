import { type ReactNode, useEffect, useState } from 'react'
import { meetingsApi } from '../api/meetings'
import { secondaryButton } from '../apps/meetings/components/common'
import {
  disableReminders,
  enableReminders,
  type ReminderState,
  reminderState,
} from '../apps/meetings/reminders'
import { product } from '../brand/product'
import { installContext } from '../lib/install'

/**
 * Settings' "Notifications on this device": one switch for everything pushed to this browser
 * (meeting and task reminders, check-in questions, the daily briefing), which all share its push
 * subscription (docs/PLAN-install-and-settings.md, N1–N3).
 */
export function NotificationsSection() {
  const [state, setState] = useState<ReminderState | null>(null)
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    reminderState().then(
      (s) => live && setState(s),
      () => live && setState('unavailable'),
    )
    return () => {
      live = false
    }
  }, [])

  const toggle = async () => {
    if (state !== 'on' && state !== 'off') return
    setBusy(true)
    setTested(null)
    try {
      setState(state === 'on' ? await disableReminders() : await enableReminders())
    } catch {
      setState(await reminderState().catch(() => 'off' as const))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setTested(null)
    try {
      const { sent, failed } = await meetingsApi.testNotification()
      setTested(testMessage(sent, failed))
    } catch (err) {
      setTested(err instanceof Error ? err.message : 'That didn’t send. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      id="notifications"
      aria-labelledby="notifications-title"
      data-testid="settings-notifications"
      className="mt-12"
    >
      <h2
        id="notifications-title"
        className="font-display text-[1.6rem] font-semibold tracking-tight"
      >
        Notifications
      </h2>
      <p className="mt-2 text-ink-soft">
        A reminder a minute before each meeting with other people and when a timed task is due,
        check-in questions when they’re asked, and your daily briefing when it’s ready.
      </p>
      {state === null ? null : state === 'on' || state === 'off' ? (
        <>
          <label className="mt-4 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4">
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">Notifications on this device</span>
              <span className="block text-sm text-ink-soft">
                {state === 'on' ? 'On. Each device you use is switched on separately.' : 'Off.'}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={state === 'on'}
              data-testid="notifications-switch"
              checked={state === 'on'}
              disabled={busy}
              onChange={() => void toggle()}
              className="size-5 accent-ember"
            />
          </label>
          {state === 'on' ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="notifications-test"
                disabled={busy}
                onClick={() => void test()}
                className={`${secondaryButton} h-9`}
              >
                Send test notification
              </button>
              {/* Always there, so screen readers announce the text when it changes. */}
              <p
                role="status"
                data-testid="notifications-test-result"
                className="text-sm text-ink-soft"
              >
                {tested ?? ''}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <Note state={state}>{stateNote(state)}</Note>
      )}
    </section>
  )
}

function testMessage(sent: number, failed: number): string {
  const devices = (n: number) => `${n} ${n === 1 ? 'device' : 'devices'}`
  if (failed > 0) {
    const reached = sent > 0 ? `Sent to ${devices(sent)}, but couldn’t reach ` : 'Couldn’t reach '
    return `${reached}${devices(failed)}. Try again in a minute.`
  }
  if (sent === 0) return 'No device is set up for notifications yet.'
  return `Sent to ${devices(sent)}. It should arrive in a few seconds.`
}

function Note({ state, children }: { state: ReminderState; children: ReactNode }) {
  return (
    <p
      data-testid="notifications-note"
      data-state={state}
      className="mt-4 rounded-xl border border-ash bg-paper-sunk/60 p-4 text-sm text-ink-soft"
    >
      {children}
    </p>
  )
}

function stateNote(state: 'unsupported' | 'unavailable' | 'blocked'): string {
  if (state === 'blocked') {
    return `Notifications are blocked for ${product()} in this browser’s settings. Allow them there, then come back here.`
  }
  if (state === 'unavailable') {
    return `This ${product()} server isn’t sending notifications right now. Ask whoever runs it.`
  }
  const { isIOS, isInstalled } = installContext()
  return isIOS && !isInstalled
    ? `On iPhone and iPad, notifications work once ${product()} is on your Home Screen. Install it (above), open it from there, and switch notifications on.`
    : 'This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari.'
}
