import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { secondaryButton } from '../../apps/meetings/components/common'
import { product } from '../../brand/product'
import { chordFromKey, chordRefusal } from '../../lib/macScreenshotShortcut'
import {
  HISTORY_DAYS,
  type HistoryDays,
  HOTKEYS,
  type HotkeyId,
  type MacScreenshotSettings,
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
  /** The app didn't answer a read (the page can't show anything) or a change (it says so). */
  const [failed, setFailed] = useState<'read' | 'change' | null>(null)
  const [busy, setBusy] = useState(false)
  // One change at a time. Controls stay enabled (aria-disabled only), so the one in use keeps
  // keyboard focus while the Mac answers.
  const busyRef = useRef(false)

  const take = useCallback((next: MacSettings | null, kind: 'read' | 'change') => {
    if (next) {
      setSettings(next)
      setFailed(null)
    } else {
      setFailed(kind)
    }
  }, [])

  useEffect(() => {
    let live = true
    const read = () =>
      readMacSettings(bridge).then((s) => {
        if (live) take(s, 'read')
      })
    void read()
    // Back from System Settings or the Mac's own dialogs: show what changed there.
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [bridge, take])

  /** The Mac's answer, or null when it didn't answer or another change was under way. */
  const run = async (ask: () => Promise<MacSettings | null>): Promise<MacSettings | null> => {
    if (busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    try {
      const next = await ask()
      take(next, 'change')
      return next
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const change = <K extends MacSettingKey>(key: K, value: MacSettingValues[K]) =>
    run(() => setMacSetting(key, value, bridge))

  const act = (action: MacSettingsAction) => run(() => macSettingsAction(action, bridge))

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
      {failed === 'change' ? (
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
            aria-disabled={busy}
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
            aria-disabled={busy}
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
              ? 'Clean up tidies your words the way you chose in Dictate → Models (Fast, Careful or Off).'
              : 'Literal types exactly what you said.'
          }
        >
          <select
            aria-label="Mode"
            data-testid="mac-mode"
            value={settings.mode}
            aria-disabled={busy}
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

      {settings.screenshots ? (
        <ScreenshotsSection shots={settings.screenshots} busy={busy} change={change} act={act} />
      ) : null}

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
            hint="When a call starts in any app or browser (Google Meet, Zoom, Teams), a card at the top of the screen offers Take notes."
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
            aria-disabled={busy}
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
          label={
            settings.connected
              ? settings.account
                ? `Connected as ${settings.account}`
                : 'Connected'
              : 'Not connected'
          }
          hint={
            settings.connected
              ? 'Disconnecting stops dictation from cleaning up text and using your word lists until you sign in again.'
              : `Dictation still works with this Mac’s own speech recognition. Sign in to ${product()} to connect it.`
          }
          testId="mac-account"
        >
          {settings.connected ? (
            <ActionButton action="disconnect" busy={busy} onAct={act}>
              Disconnect this Mac
            </ActionButton>
          ) : null}
        </Row>
      </Section>
    </div>
  )
}

/**
 * Screenshots (docs/PLAN-screenshots.md R15): the shortcut, recorded by pressing it; the folder;
 * and what happens after a capture. Shown only by a Mac app that reports them.
 */
function ScreenshotsSection({
  shots,
  busy,
  change,
  act,
}: {
  shots: MacScreenshotSettings
  busy: boolean
  change: <K extends MacSettingKey>(
    key: K,
    value: MacSettingValues[K],
  ) => Promise<MacSettings | null>
  act: (action: MacSettingsAction) => Promise<MacSettings | null>
}) {
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const record = (e: React.KeyboardEvent) => {
    if (!recording) return
    // Tab on its own still moves on, so the keyboard is never trapped here.
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setRecording(false)
      return
    }
    e.preventDefault()
    if (e.key === 'Escape') {
      setRecording(false)
      setProblem(null)
      return
    }
    const chord = chordFromKey(e)
    if (!chord) return // modifiers only so far
    const refusal = chordRefusal(chord)
    if (refusal) {
      setProblem(refusal)
      return
    }
    setRecording(false)
    setProblem(null)
    if (chord === shots.shortcut) return
    void change('screenshotShortcut', chord).then((next) => {
      // The Mac has the last word: say so if it kept the old shortcut.
      const kept = next?.screenshots?.shortcut
      if (kept && kept !== chord) setProblem(`That shortcut can’t be used, so it’s still ${kept}.`)
    })
  }

  return (
    <Section id="screenshots" title="Screenshots">
      <Row
        label="Screenshot shortcut"
        hint="Press it in any app, then drag, click a window, or click the desktop. Press it again to stop."
      >
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="mac-screenshot-shortcut"
            aria-label={
              recording
                ? 'Press the new screenshot shortcut'
                : `Screenshot shortcut ${shots.shortcut}. Change`
            }
            aria-pressed={recording}
            aria-disabled={busy}
            onClick={() => {
              setProblem(null)
              setRecording((r) => !r)
            }}
            onKeyDown={record}
            onBlur={() => setRecording(false)}
            className={`${secondaryButton} h-9 min-w-24 font-mono ${recording ? 'ring-2 ring-ember' : ''}`}
          >
            {recording ? 'Press keys…' : shots.shortcut}
          </button>
          {shots.shortcut !== shots.defaultShortcut ? (
            <ActionButton action="resetScreenshotShortcut" busy={busy} onAct={act}>
              Reset to {shots.defaultShortcut}
            </ActionButton>
          ) : null}
        </div>
      </Row>
      {problem ? (
        <p
          role="alert"
          data-testid="mac-screenshot-shortcut-problem"
          className="border-ash border-t px-4 py-2 text-sm text-ember"
        >
          {problem}
        </p>
      ) : null}
      <Row label="Save screenshots to" hint={shots.folder} testId="mac-screenshot-folder">
        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            action="chooseScreenshotFolder"
            busy={busy}
            onAct={act}
            label="Choose the screenshots folder"
          >
            Choose…
          </ActionButton>
          <ActionButton action="showScreenshotFolder" busy={busy} onAct={act}>
            Show in Finder
          </ActionButton>
        </div>
      </Row>
      <SwitchRow
        id="screenshotCopy"
        label="Copy to the clipboard"
        hint="Ready to paste the moment you take it."
        on={shots.copy}
        busy={busy}
        onChange={(v) => void change('screenshotCopy', v)}
      />
      <SwitchRow
        id="screenshotSave"
        label="Save to the folder"
        on={shots.save}
        busy={busy}
        onChange={(v) => void change('screenshotSave', v)}
      />
      <SwitchRow
        id="screenshotPreview"
        label="Show the preview"
        hint="A small preview in the corner for a few seconds, with Edit, Copy, Share and Pin."
        on={shots.preview}
        busy={busy}
        onChange={(v) => void change('screenshotPreview', v)}
      />
    </Section>
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
        aria-disabled={props.busy}
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
        <ActionButton
          action={props.action}
          busy={props.busy}
          onAct={props.onAct}
          label={`Allow ${props.label}`}
        >
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
  label,
  children,
}: {
  action: MacSettingsAction
  busy: boolean
  /** The button's name for screen readers, when its text alone doesn't say what it's for. */
  label?: string
  onAct: (action: MacSettingsAction) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={`mac-action-${action}`}
      aria-label={label}
      aria-disabled={busy}
      onClick={() => onAct(action)}
      className={`${secondaryButton} h-9 shrink-0`}
    >
      {children}
    </button>
  )
}
