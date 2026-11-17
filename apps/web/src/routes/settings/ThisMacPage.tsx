import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { secondaryButton } from '../../apps/meetings/components/common'
import { product } from '../../brand/product'
import {
  HISTORY_DAYS,
  type HistoryDays,
  HOTKEYS,
  type HotkeyId,
  type MacSettingKey,
  type MacSettings,
  type MacSettingsAction,
  type MacSettingsBridge,
  type MacSettingValues,
  macSettingsAction,
  macSettingsBridge,
  readMacSettings,
  setMacSetting,
} from '../../lib/macSettings'

const sectionTitle = 'font-display text-[1.6rem] font-semibold tracking-tight'
const rowClass =
  'flex flex-col items-start gap-3 border-ash border-t p-4 first:border-t-0 sm:flex-row sm:items-center'

/**
 * `/settings/mac`: the Mac app's own settings (docs/PLAN-one-settings.md). The values live on the
 * Mac; every change goes through the app, and the page shows what the app answers back (R2).
 */
export default function ThisMacPage({
  bridge = macSettingsBridge(),
}: {
  bridge?: MacSettingsBridge | null
}) {
  useEffect(() => {
    document.title = `This Mac · Settings · ${product()}`
  }, [])
  if (!bridge) return <NotInMacApp />
  return <MacSettingsForm bridge={bridge} />
}

function NotInMacApp() {
  return (
    <div data-testid="settings-mac-absent">
      <h2 className={sectionTitle}>This Mac</h2>
      <p className="mt-2 text-ink-soft">
        These settings are in the {product()} Mac app: its dictation shortcut, meeting reminders,
        permissions and more. Open Settings there, or{' '}
        <Link to="/settings/apps" className="text-ember underline underline-offset-2">
          get the Mac app
        </Link>
        .
      </p>
    </div>
  )
}

function MacSettingsForm({ bridge }: { bridge: MacSettingsBridge }) {
  const [settings, setSettings] = useState<MacSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const take = useCallback((next: MacSettings | null) => {
    if (next) {
      setSettings(next)
      setFailed(false)
    } else {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    let live = true
    const read = () =>
      readMacSettings(bridge).then((s) => {
        if (live) take(s)
      })
    void read()
    // Back from System Settings or the Mac's own dialogs: show what changed there.
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [bridge, take])

  const change = async <K extends MacSettingKey>(key: K, value: MacSettingValues[K]) => {
    setBusy(true)
    try {
      take(await setMacSetting(key, value, bridge))
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: MacSettingsAction) => {
    setBusy(true)
    try {
      take(await macSettingsAction(action, bridge))
    } finally {
      setBusy(false)
    }
  }

  if (!settings) {
    return (
      <div data-testid="settings-mac" data-state={failed ? 'failed' : 'loading'}>
        <h2 className={sectionTitle}>This Mac</h2>
        <p className="mt-2 text-ink-soft" role="status">
          {failed
            ? `The ${product()} app didn’t answer. Close Settings and open it again.`
            : 'Loading…'}
        </p>
      </div>
    )
  }

  const p = settings.permissions
  const notificationsWanted =
    settings.meetingReminders || (settings.callNotesSupported && settings.offerCallNotes)

  return (
    <div data-testid="settings-mac" data-state="ready">
      <p className="text-ink-soft">
        Settings for the {product()} app on this Mac. They stay on this Mac; your other devices keep
        their own.
      </p>
      {failed ? (
        <p role="alert" data-testid="settings-mac-error" className="mt-3 text-sm text-ember">
          That didn’t change. Try again.
        </p>
      ) : null}

      <Section id="dictation" title="Dictation">
        <Row
          label="Dictation shortcut"
          hint={`Hold it to dictate into any app; tap it twice for hands-free.`}
        >
          <select
            aria-label="Dictation shortcut"
            data-testid="mac-hotkey"
            value={settings.hotkey}
            disabled={busy}
            onChange={(e) => void change('hotkey', e.target.value as HotkeyId)}
            className="h-9 rounded-lg border border-ash-strong bg-paper-raised px-2 text-sm"
          >
            {HOTKEYS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Microphone for dictation"
          hint={
            settings.microphoneChoice &&
            !settings.microphones.some((m) => m.id === settings.microphoneChoice)
              ? 'The one you picked isn’t connected, so dictation uses the Mac’s default until it is.'
              : 'Meeting recording in the Mac app follows the Mac’s default microphone.'
          }
        >
          <select
            aria-label="Microphone for dictation"
            data-testid="mac-microphone"
            value={settings.microphoneChoice ?? ''}
            disabled={busy}
            onChange={(e) => void change('microphone', e.target.value || null)}
            className="h-9 max-w-64 rounded-lg border border-ash-strong bg-paper-raised px-2 text-sm"
          >
            <option value="">Mac’s default</option>
            {settings.microphones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {settings.microphoneChoice &&
            !settings.microphones.some((m) => m.id === settings.microphoneChoice) ? (
              <option value={settings.microphoneChoice}>Not connected</option>
            ) : null}
          </select>
        </Row>
        <Row
          label="Mode"
          hint={
            settings.mode === 'clean'
              ? 'Clean up removes ums and applies corrections.'
              : 'Literal types exactly what you said.'
          }
        >
          <select
            aria-label="Mode"
            data-testid="mac-mode"
            value={settings.mode}
            disabled={busy}
            onChange={(e) =>
              void change('mode', e.target.value === 'literal' ? 'literal' : 'clean')
            }
            className="h-9 rounded-lg border border-ash-strong bg-paper-raised px-2 text-sm"
          >
            <option value="clean">Clean up</option>
            <option value="literal">Literal</option>
          </select>
        </Row>
        <SwitchRow
          id="edgeGlow"
          label="Edge glow while dictating"
          hint="A warm glow around the window you’re talking into. Still, with no flames, when Reduce motion is on."
          on={settings.edgeGlow}
          busy={busy}
          onChange={(v) => void change('edgeGlow', v)}
        />
      </Section>

      <Section id="meetings" title="Meetings">
        <SwitchRow
          id="meetingReminders"
          label="Meeting reminders"
          hint="A notification a minute before each meeting with other people."
          on={settings.meetingReminders}
          busy={busy}
          onChange={(v) => void change('meetingReminders', v)}
        />
        {settings.callNotesSupported ? (
          <SwitchRow
            id="offerCallNotes"
            label="Offer to take notes when a call starts"
            hint="When another app starts a call, a notification asks “Take notes?”."
            on={settings.offerCallNotes}
            busy={busy}
            onChange={(v) => void change('offerCallNotes', v)}
          />
        ) : null}
        {notificationsWanted && p.notifications === 'off' ? (
          <Row
            label="Notifications are off"
            hint={`Turn on Allow notifications for ${product()} in System Settings, or these can’t show.`}
            testId="mac-notifications-off"
          >
            <ActionButton action="openNotificationSettings" busy={busy} onAct={act}>
              Open Notifications settings
            </ActionButton>
          </Row>
        ) : null}
      </Section>

      <Section id="app" title="App">
        <SwitchRow
          id="openAtLogin"
          label="Open at login"
          on={settings.openAtLogin}
          busy={busy}
          onChange={(v) => void change('openAtLogin', v)}
        />
        <SwitchRow
          id="showInMenuBar"
          label="Show in menu bar"
          hint={
            settings.showInMenuBar && settings.menuBarIconHidden
              ? `macOS is hiding the icon. On a MacBook the camera notch can cover it: ⌘-drag it to the right, or turn on ${product()} under System Settings → Menu Bar.`
              : `Without it, open ${product()} from Applications or the Dock.`
          }
          on={settings.showInMenuBar}
          busy={busy}
          onChange={(v) => void change('showInMenuBar', v)}
        />
      </Section>

      <Section id="permissions" title="Permissions">
        <Permission
          label="Microphone"
          detail="To hear you while you hold the key."
          granted={p.microphone}
          action="allowMicrophone"
          busy={busy}
          onAct={act}
        />
        <Permission
          label="Accessibility"
          detail="To see the key in every app and paste for you."
          granted={p.accessibility}
          action="allowAccessibility"
          busy={busy}
          onAct={act}
        />
        <Permission
          label="Location"
          detail="For the weather where you are on Today. Rounded to about a kilometre."
          granted={p.location}
          action="allowLocation"
          busy={busy}
          onAct={act}
        />
        <Permission
          label="Notifications"
          detail="For meeting reminders and the offer to take notes on a call."
          granted={p.notifications === 'on'}
          action="allowNotifications"
          busy={busy}
          onAct={act}
        />
        <Row label="First-run steps" hint="Walks through them again. Nothing is reset.">
          <ActionButton action="runSetup" busy={busy} onAct={act}>
            Run setup again
          </ActionButton>
        </Row>
      </Section>

      <Section id="history" title="Dictation history">
        <Row
          label="Keep history for"
          hint="Dictation text stays on this Mac, readable only by you. It’s never uploaded and never includes audio."
        >
          <select
            aria-label="Keep history for"
            data-testid="mac-history-days"
            value={settings.historyDays}
            disabled={busy}
            onChange={(e) => void change('historyDays', Number(e.target.value) as HistoryDays)}
            className="h-9 rounded-lg border border-ash-strong bg-paper-raised px-2 text-sm"
          >
            {HISTORY_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Clear history"
          hint="Deletes every dictation saved on this Mac. Your word lists stay."
        >
          <ActionButton action="clearHistory" busy={busy} onAct={act}>
            Clear history…
          </ActionButton>
        </Row>
      </Section>

      <Section id="account" title="Dictate on this Mac">
        <Row
          label={settings.account ? `Connected as ${settings.account}` : 'Not connected'}
          hint={
            settings.account
              ? 'Disconnecting stops dictation from cleaning up text and using your word lists until you sign in again.'
              : `Dictation still works with this Mac’s own speech recognition. Sign in to ${product()} to connect it.`
          }
          testId="mac-account"
        >
          {settings.account ? (
            <ActionButton action="disconnect" busy={busy} onAct={act}>
              Disconnect this Mac
            </ActionButton>
          ) : null}
        </Row>
      </Section>
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={`mac-${id}`}
      aria-labelledby={`mac-${id}-title`}
      className="mt-10 scroll-mt-6 first:mt-6"
    >
      <h2 id={`mac-${id}-title`} className={sectionTitle}>
        {title}
      </h2>
      <div className="mt-4 rounded-xl border border-ash bg-paper-raised/60">{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  testId,
  children,
}: {
  label: string
  hint?: string
  testId?: string
  children?: ReactNode
}) {
  return (
    <div className={rowClass} data-testid={testId}>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{label}</span>
        {hint ? <span className="block text-sm text-ink-soft">{hint}</span> : null}
      </span>
      {children}
    </div>
  )
}

function SwitchRow(props: {
  id: string
  label: string
  hint?: string
  on: boolean
  busy: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className={`${rowClass} cursor-pointer sm:flex-row`}>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{props.label}</span>
        {props.hint ? <span className="block text-sm text-ink-soft">{props.hint}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.on}
        data-testid={`mac-${props.id}`}
        checked={props.on}
        disabled={props.busy}
        onChange={(e) => props.onChange(e.target.checked)}
        className="size-5 accent-ember"
      />
    </label>
  )
}

function Permission(props: {
  label: string
  detail: string
  granted: boolean
  action: MacSettingsAction
  busy: boolean
  onAct: (action: MacSettingsAction) => void
}) {
  return (
    <div
      className={rowClass}
      data-testid={`mac-permission-${props.label.toLowerCase()}`}
      data-granted={props.granted}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{props.label}</span>
        <span className="block text-sm text-ink-soft">{props.detail}</span>
      </span>
      {props.granted ? (
        <span className="text-sm text-ink-soft">Allowed</span>
      ) : (
        <ActionButton action={props.action} busy={props.busy} onAct={props.onAct}>
          Allow…
        </ActionButton>
      )}
    </div>
  )
}

function ActionButton({
  action,
  busy,
  onAct,
  children,
}: {
  action: MacSettingsAction
  busy: boolean
  onAct: (action: MacSettingsAction) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={`mac-action-${action}`}
      disabled={busy}
      onClick={() => onAct(action)}
      className={`${secondaryButton} h-9 shrink-0`}
    >
      {children}
    </button>
  )
}
