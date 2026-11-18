import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import { calendarApi } from '../api/calendar'
import { HotsauceApiError } from '../api/client'
import { type AccessToken, tokensApi } from '../api/tokens'
import type { CalendarChoice } from '../api/types'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import { WeatherSettingsSection } from '../apps/today/WeatherSettings'
import { product } from '../brand/product'
import { NewToken } from '../components/AiToolSetup'
import { AppearanceSettings } from '../components/AppearanceSettings'
import { initials, useSignOut } from '../components/AppRail'
import type { ShellContext } from '../components/AppShell'
import { ConnectedApps } from '../components/ConnectedApps'
import { Icon } from '../components/Icon'
import { InstallButton, InstallSheet } from '../components/InstallBar'
import { MacAppCard } from '../components/MacApp'
import { NotificationsSection } from '../components/NotificationsSection'
import { Keys } from '../keyboard/KeyCaps'
import { setSingleKeys, useSingleKeys } from '../keyboard/prefs'
import { useInstallPrompt } from '../lib/install'
import { useSession } from '../state/session'

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Never'

// The three pages of Settings everyone has (docs/PLAN-settings-pages.md, G1–G3). The menu, Help and
// the version are SettingsLayout's; the organization's pages are OrgSettingsRoute's.

function usePageTitle(page: string) {
  useEffect(() => {
    document.title = `${page} · Settings · ${product()}`
  }, [page])
}

/** `/settings`: the account, then what this device remembers. */
export function GeneralSettings() {
  usePageTitle('General')
  return (
    <div data-testid="settings-general">
      <AccountSection />
      <p
        data-testid="settings-device-label"
        className="mt-12 -mb-6 text-xs font-semibold tracking-wide text-ink-faint uppercase"
      >
        On this device
      </p>
      <div className="mt-12">
        <AppearanceSettings />
      </div>
      <NotificationsSection />
      <KeyboardSettings />
      <WeatherSettingsSection />
    </div>
  )
}

/** `/settings/connections`: what your account lets in and reads from (ARCHITECTURE §7.8, §8.1). */
export function ConnectionsSettings() {
  usePageTitle('Connections')
  return (
    <div data-testid="settings-connections">
      <CalendarPicker />
      <AiToolsSection />
      <ConnectedApps origin={window.location.origin} />
    </div>
  )
}

/** `/settings/apps`: the Mac app, the web app in the browser, and the Chrome extension. */
export function AppsSettings() {
  usePageTitle('Apps')
  return (
    <div data-testid="settings-apps">
      <InstallSection />
    </div>
  )
}

/** Access tokens for connecting AI tools and scripts: make one, see them, revoke one. */
function AiToolsSection() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<(AccessToken & { token: string }) | null>(null)

  const load = useCallback(() => {
    tokensApi.list().then(setTokens, (err: unknown) => setError(messageOf(err)))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setCreated(await tokensApi.create(name))
      load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (token: AccessToken) => {
    if (!window.confirm(`Revoke “${token.name}”? Anything using it stops working at once.`)) return
    setError(null)
    try {
      await tokensApi.revoke(token.id)
      if (created?.id === token.id) setCreated(null)
      load()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const origin = window.location.origin

  return (
    <section
      id="ai-tools"
      aria-labelledby="ai-tools-title"
      data-testid="settings-ai-tools"
      className="mt-12 scroll-mt-6"
    >
      <h2 id="ai-tools-title" className={sectionTitle}>
        Connect an AI tool to {product()}
      </h2>
      <p className="mt-2 text-ink-soft">
        A token lets Claude Code, Codex, Cursor or a script work in {product()} as you. Make one per
        tool and treat it like a password. Claude, ChatGPT and Grok{' '}
        <a href="#connected-apps" className="text-ember-strong underline">
          sign in instead
        </a>
        .
      </p>
      <details data-testid="ai-tools-about" className="mt-2 text-sm text-ink-soft">
        <summary className="cursor-pointer text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink">
          What can a connected tool do?
        </summary>
        <p className="mt-2">
          Search, read, write, move and restore Docs; read Meetings and ask about them; manage Tasks
          and Notes; read Clips and your calendar. It sees exactly what you see, and everything it
          writes is saved under your name, marked with the tool that made it.
        </p>
        <p className="mt-2">
          Once connected, your AI tool reads your{' '}
          <Link to="/meetings/brief" className="text-ember-strong underline">
            agent brief
          </Link>{' '}
          first, so it already knows your priorities, projects and people.
        </p>
      </details>

      <form onSubmit={(e) => void create(e)} className="mt-6 flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-ink-soft">
          Token name
          <input
            data-testid="token-name"
            value={name}
            placeholder="My AI tool"
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="h-10 rounded-lg border border-ash-strong bg-paper-raised px-3 text-ink focus:border-ember focus:outline-none"
          />
        </label>
        <button
          type="submit"
          data-testid="token-create"
          disabled={busy || name.trim() === ''}
          className={primaryButton}
        >
          <Icon name="plus" />
          Create token
        </button>
      </form>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}

      {created ? (
        <NewToken token={created} origin={origin} onDone={() => setCreated(null)} />
      ) : null}

      <h3 className="mt-10 text-sm font-semibold text-ink-soft">Your tokens</h3>
      {tokens === null ? null : tokens.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">No tokens yet.</p>
      ) : (
        <ul
          data-testid="token-list"
          className="mt-2 divide-y divide-ash/70 rounded-xl border border-ash"
        >
          {tokens.map((t) => (
            <li
              key={t.id}
              data-testid="token-item"
              data-id={t.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.name}</span>
              <span className="font-mono text-xs text-ink-faint">hth_…{t.hint}</span>
              <span className="text-xs text-ink-faint">Created {when(t.createdAt)}</span>
              <span className="text-xs text-ink-faint">Last used {when(t.lastUsedAt)}</span>
              <button
                type="button"
                data-testid="token-revoke"
                onClick={() => void revoke(t)}
                className="text-xs text-ink-soft hover:text-ember-strong"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const sectionTitle = 'font-display text-[1.6rem] font-semibold tracking-tight'
const card = 'mt-4 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4'

/** Who is signed in, and Sign out (which forgets this browser's reminders first). */
function AccountSection() {
  const session = useSession()
  const signOut = useSignOut()
  const principal = session.me?.principal
  return (
    <section aria-labelledby="account-title" data-testid="settings-account">
      <h2 id="account-title" className={sectionTitle}>
        Account
      </h2>
      <div className={card}>
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-ash-strong text-sm font-semibold text-paper-raised"
        >
          {initials(principal?.name, principal?.email)}
        </span>
        <span className="min-w-0 flex-1">
          {principal?.name ? (
            <span className="block truncate font-medium text-ink">{principal.name}</span>
          ) : null}
          <span data-testid="settings-email" className="block truncate text-sm text-ink-soft">
            {principal?.email ?? ''}
          </span>
        </span>
        <button
          type="button"
          data-testid="settings-sign-out"
          onClick={signOut}
          className={`${secondaryButton} h-9 shrink-0`}
        >
          Sign out
        </button>
      </div>
    </section>
  )
}

/** Settings → Apps: the Mac app, the web app in the browser, and the Chrome extension. */
function InstallSection() {
  return (
    <section aria-labelledby="install-title" data-testid="settings-install">
      <h2 id="install-title" className={sectionTitle}>
        Apps
      </h2>
      <p className="mt-2 text-ink-soft">Other ways to use {product()}.</p>
      <div className="mt-4 space-y-4">
        <MacAppCard />
        <WebAppCard />
        <ExtensionCard />
      </div>
    </section>
  )
}

/** The installable web app: the browser's dialog, or how to add it to the Home Screen. */
function WebAppCard() {
  const install = useInstallPrompt()
  const [howTo, setHowTo] = useState(false)
  // The live demo ships no service worker, and nobody should install a demo (vite.config.ts).
  if (import.meta.env.MODE === 'demo') return null
  return (
    <div data-testid="web-app">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4">
        <Icon name={install.isMobile ? 'phone' : 'apps'} className="size-5 shrink-0 text-ember" />
        <span className="min-w-0 flex-1 basis-56">
          <span className="block font-medium text-ink">Web app</span>
          <span className="block text-sm text-ink-soft">
            {install.isInstalled
              ? `You’re using the installed ${product()} app.`
              : `Put ${product()} on your ${install.isMobile ? 'Home Screen' : 'dock or taskbar'} from Chrome, so it opens in its own window like any other app.`}
          </span>
        </span>
        {install.isInstalled ? (
          <span
            data-testid="settings-installed"
            className="flex shrink-0 items-center gap-1 text-sm font-medium text-moss"
          >
            <Icon name="check" className="size-4" />
            Installed
          </span>
        ) : (
          <InstallButton
            install={install}
            onHowTo={() => setHowTo(true)}
            testId="settings-install-button"
            className={`${primaryButton} h-9 shrink-0`}
          />
        )}
      </div>
      {howTo ? (
        <InstallSheet
          isIOS={install.isIOS}
          isMobile={install.isMobile}
          onClose={() => setHowTo(false)}
        />
      ) : null}
    </div>
  )
}

/** The Chrome extension: its own page says how to install it. */
function ExtensionCard() {
  return (
    <Link
      to="/meetings/extension"
      data-testid="settings-extension"
      className="flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4 hover:border-ember"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">Chrome extension</span>
        <span className="block text-sm text-ink-soft">
          Take notes on a Google Meet call in one click, and save any page to Links.
        </span>
      </span>
      <Icon name="chevron" className="size-4 text-ink-faint" />
    </Link>
  )
}

/** Primary is always on; ticking another calendar saves the whole choice. */
function CalendarPicker() {
  const [calendars, setCalendars] = useState<CalendarChoice[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    calendarApi.calendars().then(
      (r) => {
        if (!cancelled) setCalendars(r.calendars)
      },
      (err: unknown) => {
        if (!cancelled) setError(messageOf(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async (choice: CalendarChoice) => {
    if (!calendars || choice.primary) return
    const ids = calendars
      .filter((c) => !c.primary && (c.id === choice.id ? !c.selected : c.selected))
      .map((c) => c.id)
    setSaving(true)
    setError(null)
    try {
      setCalendars((await calendarApi.setCalendars(ids)).calendars)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="calendars" aria-labelledby="calendars-title" className="scroll-mt-6">
      <h2 id="calendars-title" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Calendars
      </h2>
      <p className="mt-2 text-ink-soft">
        {product()} Meetings reads your main Google calendar. Tick any others whose meetings you
        take notes in.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      {calendars ? (
        <ul className="mt-4 divide-y divide-ash/70 rounded-xl border border-ash">
          {calendars.map((c) => (
            <li key={c.id} data-testid="calendar-choice" data-calendar-id={c.id}>
              <label className="flex items-center gap-3 px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={c.primary || c.selected}
                  disabled={c.primary || saving}
                  onChange={() => void toggle(c)}
                />
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full bg-ash-strong"
                  style={c.color ? { backgroundColor: c.color } : undefined}
                />
                <span className="min-w-0 flex-1 truncate text-ink">{c.name}</span>
                {c.primary ? <span className="text-xs text-ink-faint">Always on</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function messageOf(err: unknown): string {
  return err instanceof HotsauceApiError || err instanceof Error ? err.message : String(err)
}

/** Single-key shortcuts on or off (WCAG 2.1.4), and the way to the full list. */
function KeyboardSettings() {
  const on = useSingleKeys()
  const shell = useOutletContext<ShellContext | undefined>()
  return (
    <section id="keyboard" aria-labelledby="keyboard-title" className="mt-12 scroll-mt-6">
      <h2 id="keyboard-title" className="font-display text-[1.6rem] font-semibold tracking-tight">
        Keyboard
      </h2>
      <p className="mt-2 text-ink-soft">
        Press <Keys spec="?" /> anywhere to see every shortcut, and <Keys spec="mod+k" /> to open
        the command menu.
      </p>
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          data-testid="single-keys"
          onChange={(e) => setSingleKeys(e.target.checked)}
          className="mt-1 size-4 accent-ember"
        />
        <span>
          <span className="block font-medium text-ink">Single-key shortcuts</span>
          <span className="block text-sm text-ink-soft">
            Keys like <Keys spec="j" /> <Keys spec="x" /> and <Keys spec="?" /> work when you aren't
            typing. Turn them off if you use voice control or they get in your way. Shortcuts with ⌘
            or Ctrl always work. On this device.
          </span>
        </span>
      </label>
      {shell ? (
        <button
          type="button"
          data-testid="show-shortcuts"
          onClick={shell.openShortcuts}
          className={`${secondaryButton} mt-4`}
        >
          Show all shortcuts
        </button>
      ) : null}
    </section>
  )
}
