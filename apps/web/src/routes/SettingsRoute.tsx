import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useOutletContext, useRouteLoaderData } from 'react-router'
import { calendarApi } from '../api/calendar'
import { api, HearthApiError } from '../api/client'
import { type AccessToken, claudeCodeCommand, claudeDesktopConfig, tokensApi } from '../api/tokens'
import type { CalendarChoice, Health } from '../api/types'
import {
  MeetingsPageHeader,
  primaryButton,
  secondaryButton,
} from '../apps/meetings/components/common'
import { WeatherSettingsSection } from '../apps/today/WeatherSettings'
import { product } from '../brand/product'
import { feedbackLink, initials, useFeedbackEnabled, useSignOut } from '../components/AppRail'
import type { ShellContext } from '../components/AppShell'
import { Icon } from '../components/Icon'
import { InstallButton, InstallSheet } from '../components/InstallBar'
import { MacAppSection } from '../components/MacApp'
import { NotificationsSection } from '../components/NotificationsSection'
import { Keys } from '../keyboard/KeyCaps'
import { setSingleKeys, useSingleKeys } from '../keyboard/prefs'
import { useInstallPrompt } from '../lib/install'
import { chooseTheme, currentTheme, type ThemeChoice } from '../lib/theme'
import { useSession } from '../state/session'

/** The help center, and its frequently asked questions. */
export const HELP_DOCS = 'https://hotsauce.work/help'
export const HELP_FAQ = 'https://hotsauce.work/faq'

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Never'

/**
 * `/settings`, top to bottom (docs/PLAN-install-and-settings.md): the account, installing the
 * app, notifications on this device, appearance, the Mac app and Chrome extension, access tokens
 * for connecting Claude and scripts (ARCHITECTURE §8.1), which Google calendars Meetings reads
 * (§7.8), help, and the version.
 */
export default function SettingsRoute() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [name, setName] = useState('Claude Code')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<(AccessToken & { token: string }) | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  // Today links to `#mac-app`; the router doesn't scroll to it.
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash])

  useEffect(() => {
    api.me().then(
      (me) => setIsAdmin(me.principal.isAdmin),
      () => {},
    )
  }, [])

  const load = useCallback(() => {
    tokensApi.list().then(setTokens, (err: unknown) => setError(messageOf(err)))
  }, [])

  useEffect(() => {
    document.title = `Settings · ${product()}`
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
    <>
      <MeetingsPageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-6 md:pt-10">
          {isAdmin ? (
            <Link
              to="/settings/organization"
              data-testid="org-settings-link"
              className="mb-8 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4 hover:border-ember"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">Organization</span>
                <span className="block text-sm text-ink-soft">
                  Name, brand, sign-in, AI keys and storage for everyone. Admins only.
                </span>
              </span>
              <Icon name="chevron" className="size-4 text-ink-faint" />
            </Link>
          ) : null}
          <AccountSection />
          <InstallSection />
          <NotificationsSection />
          <div className="mt-12">
            <AppearancePicker />
          </div>
          <WeatherSettingsSection />
          <KeyboardSettings />
          <MacAppSection />
          <ExtensionCard />

          <h2 className="mt-12 font-display text-[1.6rem] font-semibold tracking-tight">
            Connect Claude to {product()}
          </h2>
          <p className="mt-2 text-ink-soft">
            An access token lets Claude Code, Claude desktop or a script work in {product()} as you:
            search, read, write, move and restore Docs; read Meetings and ask about them; manage
            Tasks and Notes; read Clips and your calendar. It sees exactly what you see, and
            everything it writes is saved under your name, marked as made through Claude. Treat a
            token like a password, and revoke it when you stop using it.
          </p>
          <p className="mt-2 text-ink-soft">
            Once connected, Claude reads your{' '}
            <Link to="/meetings/brief" className="text-ember-strong underline">
              agent brief
            </Link>{' '}
            first, so it already knows your priorities, projects and people.
          </p>

          <form onSubmit={(e) => void create(e)} className="mt-6 flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-ink-soft">
              Token name
              <input
                data-testid="token-name"
                value={name}
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

          <CalendarPicker />
          <HelpSection />
          <AboutSection />
        </div>
      </div>
    </>
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

/** Install the app: the browser's dialog, or how to add it to the Home Screen. */
function InstallSection() {
  const install = useInstallPrompt()
  const [howTo, setHowTo] = useState(false)
  // The live demo ships no service worker, and nobody should install a demo (vite.config.ts).
  if (import.meta.env.MODE === 'demo') return null
  return (
    <section aria-labelledby="install-title" data-testid="settings-install" className="mt-12">
      <h2 id="install-title" className={sectionTitle}>
        Install app
      </h2>
      <div className={card}>
        <Icon name={install.isMobile ? 'phone' : 'laptop'} className="size-5 shrink-0 text-ember" />
        <span className="min-w-0 flex-1 text-sm text-ink-soft">
          {install.isInstalled
            ? `You’re using the installed ${product()} app.`
            : `Put ${product()} on your ${install.isMobile ? 'Home Screen' : 'dock or taskbar'} so it opens in its own window, like any other app.`}
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
    </section>
  )
}

/** The Chrome extension, beside the Mac app: its own page says how to install it. */
function ExtensionCard() {
  return (
    <Link
      to="/meetings/extension"
      data-testid="settings-extension"
      className="mt-4 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4 hover:border-ember"
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

function HelpSection() {
  const feedbackOn = useFeedbackEnabled()
  const { pathname } = useLocation()
  return (
    <section aria-labelledby="help-title" data-testid="settings-help" className="mt-12">
      <h2 id="help-title" className={sectionTitle}>
        Help
      </h2>
      <div className="mt-4 flex flex-wrap gap-3">
        {feedbackOn ? (
          <Link
            to={feedbackLink(pathname)}
            data-testid="settings-feedback"
            className={secondaryButton}
          >
            <Icon name="chat" />
            Send feedback
          </Link>
        ) : null}
        <a
          href={HELP_DOCS}
          target="_blank"
          rel="noreferrer"
          data-testid="settings-help-docs"
          className={secondaryButton}
        >
          <Icon name="book" />
          Help center
          <Icon name="external" className="size-3 opacity-75" />
        </a>
        <a
          href={HELP_FAQ}
          target="_blank"
          rel="noreferrer"
          data-testid="settings-help-faq"
          className={secondaryButton}
        >
          FAQ
          <Icon name="external" className="size-3 opacity-75" />
        </a>
      </div>
    </section>
  )
}

/**
 * The version this server runs. Updates apply on their own (vite.config.ts: autoUpdate with
 * skipWaiting), so Reload just checks for a newer build and reloads the page.
 */
function AboutSection() {
  const health = useRouteLoaderData('root') as Health | undefined
  const [reloading, setReloading] = useState(false)
  const reload = async () => {
    setReloading(true)
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      await reg?.update()
    } catch {
      // Offline or no worker: reloading still picks up whatever is cached.
    }
    window.location.reload()
  }
  return (
    <section aria-labelledby="about-title" data-testid="settings-about" className="mt-12">
      <h2 id="about-title" className={sectionTitle}>
        About
      </h2>
      <div className={card}>
        <span className="min-w-0 flex-1 text-sm text-ink-soft">
          {product()}{' '}
          <span data-testid="settings-version" className="font-mono text-ink">
            {health?.version ? `version ${health.version}` : ''}
          </span>
          <span className="block">New versions install themselves; reload to get one now.</span>
        </span>
        <button
          type="button"
          data-testid="settings-reload"
          disabled={reloading}
          onClick={() => void reload()}
          className={`${secondaryButton} h-9 shrink-0`}
        >
          <Icon name="restart" />
          Reload
        </button>
      </div>
    </section>
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
    <section aria-labelledby="calendars" className="mt-12">
      <h2 id="calendars" className="font-display text-[1.6rem] font-semibold tracking-tight">
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

function NewToken({
  token,
  origin,
  onDone,
}: {
  token: AccessToken & { token: string }
  origin: string
  onDone: () => void
}) {
  return (
    <section
      data-testid="token-created"
      className="mt-6 rounded-xl border border-ember/40 bg-paper-raised/70 p-4"
    >
      <p className="text-sm font-medium text-ink">
        Copy “{token.name}” now. {product()} won’t show it again.
      </p>
      <CopyBlock testId="token-secret" text={token.token} />

      <h4 className="mt-5 text-sm font-semibold text-ink-soft">Claude Code</h4>
      <p className="mt-1 text-sm text-ink-soft">Run this once in a terminal:</p>
      <CopyBlock testId="token-command" text={claudeCodeCommand(origin, token.token)} />

      <h4 className="mt-5 text-sm font-semibold text-ink-soft">Claude desktop</h4>
      <p className="mt-1 text-sm text-ink-soft">
        Add this to <code className="font-mono text-xs">claude_desktop_config.json</code> (Settings
        → Developer → Edit Config), then restart Claude. It needs Node installed.
      </p>
      <CopyBlock testId="token-desktop-config" text={claudeDesktopConfig(origin, token.token)} />

      <button type="button" onClick={onDone} className={`${secondaryButton} mt-5 h-9`}>
        Done
      </button>
    </section>
  )
}

function CopyBlock({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-ash bg-paper-sunk p-2">
      <pre
        data-testid={testId}
        className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink"
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy"
        className="shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-paper hover:text-ink"
      >
        <Icon name={copied ? 'check' : 'copy'} className="size-4" />
      </button>
    </div>
  )
}

function messageOf(err: unknown): string {
  return err instanceof HearthApiError || err instanceof Error ? err.message : String(err)
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Match my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Light, dark, or whatever the device uses; this browser remembers it. */
function AppearancePicker() {
  const [theme, setTheme] = useState<ThemeChoice>(currentTheme)
  return (
    <fieldset data-testid="theme-picker">
      <legend className="font-display text-[1.6rem] font-semibold tracking-tight">
        Appearance
      </legend>
      <p className="mt-2 text-ink-soft">Light or dark, on this device.</p>
      <div className="mt-4 inline-flex flex-wrap rounded-xl border border-ash bg-paper-sunk p-1">
        {THEMES.map((option) => {
          const on = theme === option.value
          return (
            <label
              key={option.value}
              className={`cursor-pointer rounded-lg px-3.5 py-1.5 text-sm transition-colors has-[:focus-visible]:shadow-[var(--focus-ring)] ${
                on
                  ? 'bg-paper-raised font-medium text-ink shadow-sm'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={on}
                data-testid={`theme-${option.value}`}
                onChange={() => {
                  chooseTheme(option.value)
                  setTheme(option.value)
                }}
                className="sr-only"
              />
              {option.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
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
