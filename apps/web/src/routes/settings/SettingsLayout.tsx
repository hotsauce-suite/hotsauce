import { useEffect, useRef, useState } from 'react'
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useRouteLoaderData,
} from 'react-router'
import type { Health } from '../../api/types'
import { MeetingsPageHeader } from '../../apps/meetings/components/common'
import { product } from '../../brand/product'
import { feedbackLink, useFeedbackEnabled } from '../../components/AppRail'
import { Icon } from '../../components/Icon'
import { onFeedbackClick } from '../../feedback/pageShot'
import { useShortcut } from '../../keyboard/shortcuts'
import { hasMacSettings } from '../../lib/macSettings'
import { useSession } from '../../state/session'
import { MAC_PAGE, movedSection, ORG_PAGES, type SettingsPage, YOUR_PAGES } from './pages'
import {
  type FindState,
  resultCount,
  SearchBox,
  SearchResults,
  useFoundSection,
} from './SettingsSearch'
import { type SettingEntry, searchSettings } from './searchIndex'

/** The help center, and its frequently asked questions. */
export const HELP_DOCS = 'https://hotsauce.work/help'
export const HELP_FAQ = 'https://hotsauce.work/faq'

/**
 * Settings: a menu of small pages (docs/PLAN-settings-pages.md). A column beside the page on wide
 * screens, a row of tabs above it on narrow ones; Help and the version sit under the menu on
 * every page. Admins also get the organization's pages.
 */
export default function SettingsLayout() {
  const isAdmin = useSession().me?.principal.isAdmin === true
  // Inside the Mac app, This Mac comes first (docs/PLAN-one-settings.md R1).
  const mac = hasMacSettings()
  const { pathname, hash, state, key } = useLocation()
  const navigate = useNavigate()
  // The pages still reach the shell (the shortcuts sheet) through the outlet.
  const shell = useOutletContext()

  // Search (docs/PLAN-settings-search.md): what's typed stands in for the page until it's cleared
  // or a result is chosen. The page stays mounted underneath, so nothing typed into it is lost.
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  const results = searching ? searchSettings(query, { admin: isAdmin, mac }) : []
  const box = useRef<HTMLInputElement>(null)
  const choose = (entry: SettingEntry | undefined) => {
    if (!entry) return
    setQuery('')
    void navigate(entry.to, { state: { settingsFind: entry.title } satisfies FindState })
  }
  // Any move to another page (a tab, ⌘K, Back) ends the search.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each move is a new location key
  useEffect(() => setQuery(''), [key])
  const content = useRef<HTMLDivElement>(null)
  useShortcut('global.search', () => {
    box.current?.focus()
    return true
  })

  // An address from before Settings had pages opens the page its section moved to (G4).
  const moved = movedSection(pathname, hash)
  useEffect(() => {
    if (moved) void navigate(moved, { replace: true })
  }, [moved, navigate])

  // The router doesn't scroll to a section named in the address, and the pane outlives the page:
  // a new page starts at its top, or at its section.
  const pane = useRef<HTMLDivElement>(null)
  useFoundSection(pane, content)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page is the reason to scroll
  useEffect(() => {
    if (moved) return
    // A search result scrolls to its own section (useFoundSection).
    if ((state as FindState | null)?.settingsFind) return
    if (!hash) {
      pane.current?.scrollTo?.({ top: 0 })
      return
    }
    const id = hash.slice(1)
    let last: number | null = null
    let tries = 0
    // The page loads lazily and what sits above the section (calendars, the organization's
    // state) arrives later still, so keep the section in place until it stops moving.
    const timer = window.setInterval(() => {
      const el = document.getElementById(id)
      const top = el?.getBoundingClientRect().top ?? null
      if (el && top !== last) el.scrollIntoView({ block: 'start' })
      last = el ? el.getBoundingClientRect().top : null
      if (++tries > 30) window.clearInterval(timer)
    }, 100)
    // Their own scrolling wins over ours.
    const stop = () => window.clearInterval(timer)
    window.addEventListener('wheel', stop, { once: true, passive: true })
    window.addEventListener('touchmove', stop, { once: true, passive: true })
    window.addEventListener('keydown', stop, { once: true })
    return () => {
      stop()
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('keydown', stop)
    }
  }, [pathname, hash, moved])

  // On a phone the menu is one row that scrolls: keep the current page's tab in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page is the reason to scroll
  useEffect(() => {
    document
      .querySelector('[data-testid="settings-nav"] [aria-current="page"]')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [pathname, isAdmin])

  return (
    <>
      <MeetingsPageHeader title="Settings" />
      <div ref={pane} className="min-h-0 flex-1 overflow-y-auto" data-testid="settings-scroll">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-10 px-4 pt-4 pb-24 md:grid-cols-[13rem_minmax(0,1fr)] md:px-6 md:pt-10">
          {/* Beside the page, the menu and the help strip are one column that stays put while the
              page scrolls (and scrolls by itself in a window too short for it). On a phone they
              are the tabs above the page and the strip below it. */}
          <div
            data-testid="settings-side"
            className="contents md:sticky md:top-10 md:col-start-1 md:row-start-1 md:block md:max-h-[calc(100dvh-7rem)] md:self-start md:overflow-y-auto"
          >
            <SearchBox
              value={query}
              onChange={setQuery}
              onChoose={() => choose(results[0])}
              inputRef={box}
              searching={searching}
            />
            <nav
              aria-label="Settings"
              data-testid="settings-nav"
              className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
            >
              <Group pages={mac ? [MAC_PAGE, ...YOUR_PAGES] : YOUR_PAGES} />
              {isAdmin ? (
                <>
                  <span
                    className="hidden px-2.5 pt-5 pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase md:block"
                    data-testid="settings-nav-org"
                  >
                    Organization
                  </span>
                  <span aria-hidden="true" className="mx-1 w-px shrink-0 bg-ash md:hidden" />
                  {/* The heading is hidden on phones; the group still says what these are. */}
                  {/* biome-ignore lint/a11y/useSemanticElements: links in a nav, not form fields */}
                  <div role="group" aria-label="Organization" className="contents">
                    <Group pages={ORG_PAGES} />
                  </div>
                </>
              ) : null}
            </nav>
            <HelpStrip />
          </div>
          <div
            data-testid="settings-page"
            className="order-1 min-w-0 pt-4 md:order-none md:col-start-2 md:row-start-1 md:pt-0"
          >
            {/* Always there, so the first count is read out too. */}
            <p aria-live="polite" className="sr-only" data-testid="settings-search-announce">
              {searching ? resultCount(query, results.length) : ''}
            </p>
            {searching ? (
              <SearchResults query={query} results={results} onChoose={choose} inputRef={box} />
            ) : null}
            {/* Hidden and inert under the results: still mounted, so nothing typed into it is
                lost, but its shortcuts and focus are off. */}
            <div ref={content} hidden={searching} inert={searching} data-testid="settings-content">
              <Outlet context={shell} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function Group({ pages }: { pages: SettingsPage[] }) {
  return (
    <>
      {pages.map((page) => (
        <NavLink
          key={page.id}
          to={page.to}
          // General and Workspace are prefixes of the pages after them.
          end
          data-testid={`settings-nav-${page.id}`}
          className={({ isActive }) =>
            `shrink-0 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none ${
              isActive
                ? 'bg-paper-sunk font-medium text-ink'
                : 'text-ink-soft hover:bg-paper-sunk/60 hover:text-ink'
            }`
          }
        >
          {page.label}
        </NavLink>
      ))}
    </>
  )
}

const stripLink =
  'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-ink-soft hover:bg-paper-sunk/60 hover:text-ink'

/**
 * Help, feedback and the version, on every Settings page (L3). Updates apply on their own
 * (vite.config.ts: autoUpdate with skipWaiting), so Reload just checks for a newer build and
 * reloads the page.
 */
function HelpStrip() {
  const health = useRouteLoaderData('root') as Health | undefined
  const feedbackOn = useFeedbackEnabled()
  const { pathname } = useLocation()
  const navigate = useNavigate()
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
    <aside
      aria-label="Help and version"
      data-testid="settings-help"
      className="order-2 mt-12 flex flex-col gap-0.5 border-t border-ash/70 pt-4 md:order-none md:mt-6"
    >
      <a
        href={HELP_DOCS}
        target="_blank"
        rel="noreferrer"
        data-testid="settings-help-docs"
        className={stripLink}
      >
        Help center
        <Icon name="external" className="size-3 opacity-75" />
      </a>
      <a
        href={HELP_FAQ}
        target="_blank"
        rel="noreferrer"
        data-testid="settings-help-faq"
        className={stripLink}
      >
        FAQ
        <Icon name="external" className="size-3 opacity-75" />
      </a>
      {/* Replays the first-run tile on Today (docs/PLAN-getting-started.md R1). */}
      <Link to="/today?start=1" data-testid="settings-getting-started" className={stripLink}>
        Getting started
      </Link>
      {feedbackOn ? (
        <Link
          to={feedbackLink(pathname)}
          onClick={onFeedbackClick(navigate, pathname)}
          data-testid="settings-feedback"
          className={stripLink}
        >
          Send feedback
        </Link>
      ) : null}
      {/* The release notes (docs/PLAN-mac-version-and-whats-new.md, N5). */}
      <NavLink
        to="/settings/whats-new"
        data-testid="settings-whats-new-link"
        className={({ isActive }) =>
          `${stripLink} ${isActive ? 'bg-paper-sunk font-medium text-ink' : ''}`
        }
      >
        What’s new
      </NavLink>
      <p
        data-testid="settings-about"
        className="mt-2 px-2.5 text-xs text-ink-faint"
        title="New versions install themselves; reload to get one now."
      >
        {product()}{' '}
        {health?.version ? (
          <Link
            to="/settings/whats-new"
            data-testid="settings-version"
            className="font-mono hover:text-ink hover:underline"
          >
            version {health.version}
          </Link>
        ) : null}
        <button
          type="button"
          data-testid="settings-reload"
          disabled={reloading}
          onClick={() => void reload()}
          className="ml-2 underline decoration-ash-strong underline-offset-2 hover:text-ink"
        >
          Reload
        </button>
      </p>
    </aside>
  )
}
