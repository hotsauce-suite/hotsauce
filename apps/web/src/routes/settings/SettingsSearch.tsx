import { type KeyboardEvent, type RefObject, useEffect } from 'react'
import { useLocation } from 'react-router'
import { Icon } from '../../components/Icon'
import type { SettingEntry } from './searchIndex'

// Settings search (docs/PLAN-settings-search.md): the box above the menu (S1), the results that
// stand in for the page while something is typed (S4), and finding the chosen section on its page
// (S5).

/** What a result carries to its page: the heading to scroll to. */
export interface FindState {
  settingsFind: string
}

export function SearchBox({
  value,
  onChange,
  onChoose,
  inputRef,
  searching,
}: {
  searching: boolean
  value: string
  onChange: (value: string) => void
  /** Enter: the first result. */
  onChoose: () => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onChoose()
    } else if (e.key === 'Escape' && value) {
      e.preventDefault()
      e.stopPropagation()
      onChange('')
    } else if (e.key === 'ArrowDown') {
      const first = document.querySelector<HTMLElement>('[data-testid="settings-search-result"]')
      if (first) {
        e.preventDefault()
        first.focus()
      }
    }
  }
  return (
    <search className="relative mb-3 md:mb-4" data-testid="settings-search">
      <Icon
        name="search"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keys}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-controls={searching ? 'settings-search-results' : undefined}
        data-testid="settings-search-input"
        className="h-9 w-full rounded-lg border border-ash bg-paper-raised pr-3 pl-9 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
      />
    </search>
  )
}

/** Up and down move between results; Escape goes back to the box. */
function resultKeys(e: KeyboardEvent<HTMLUListElement>, input: HTMLInputElement | null) {
  const rows = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="settings-search-result"]'),
  ]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = at + (e.key === 'ArrowDown' ? 1 : -1)
    if (next < 0) input?.focus()
    else rows[Math.min(next, rows.length - 1)]?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    input?.focus()
  }
}

export function SearchResults({
  query,
  results,
  onChoose,
  inputRef,
}: {
  query: string
  results: SettingEntry[]
  onChoose: (entry: SettingEntry) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const typed = query.trim()
  return (
    <section
      id="settings-search-results"
      aria-label="Settings search results"
      data-testid="settings-search-results"
    >
      <p
        aria-live="polite"
        className="mb-3 text-sm text-ink-faint"
        data-testid="settings-search-count"
      >
        {results.length === 0
          ? `Nothing in Settings matches “${typed}”.`
          : results.length === 1
            ? '1 setting'
            : `${results.length} settings`}
      </p>
      {results.length ? (
        <ul
          className="divide-y divide-ash/70 rounded-xl border border-ash"
          onKeyDown={(e) => resultKeys(e, inputRef.current)}
        >
          {results.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                data-testid="settings-search-result"
                data-setting={entry.id}
                onClick={() => onChoose(entry)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-paper-sunk/60 focus-visible:bg-paper-sunk focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{entry.title}</span>
                  <span className="block text-sm text-ink-soft">{entry.summary}</span>
                </span>
                <span className="shrink-0 pt-0.5 text-xs text-ink-faint">
                  {entry.admin ? `Organization · ${entry.page}` : entry.page}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** "3 settings", or that nothing matches. */
export function resultCount(query: string, count: number): string {
  if (count === 0) return `Nothing in Settings matches “${query.trim()}”.`
  return count === 1 ? '1 setting' : `${count} settings`
}

const HEADINGS = 'h2, h3, legend, .font-medium'
const squash = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim()

/** The heading in `root` that is `title`, or failing that, starts with it. */
export function findHeading(root: ParentNode, title: string): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(HEADINGS)]
  return (
    all.find((el) => squash(el.textContent) === title) ??
    all.find((el) => squash(el.textContent).startsWith(title)) ??
    null
  )
}

/**
 * After a result is chosen: keep its section in view as the page loads (it loads lazily, and what
 * sits above the section can arrive later still), mark it for a moment, and move focus to it. The
 * page's own content is searched, never the results. Once found, the request is dropped from
 * history so a reload or Back doesn't replay it; if it's never found, the page starts at its top.
 */
export function useFoundSection(
  pane: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  const location = useLocation()
  const title = (location.state as FindState | null)?.settingsFind
  // biome-ignore lint/correctness/useExhaustiveDependencies: each choice is a new location
  useEffect(() => {
    if (!title) return
    let found: HTMLElement | null = null
    let marked: HTMLElement | null = null
    let last: number | null = null
    let tries = 0
    let unmark: number | undefined
    const timer = window.setInterval(() => {
      const heading = content.current ? findHeading(content.current, title) : null
      if (heading && !found) {
        found = heading
        marked = heading.closest<HTMLElement>('section, fieldset, form, [data-testid]') ?? heading
        // Taken off and put back, so choosing the same section again replays the mark.
        marked.removeAttribute('data-settings-found')
        void marked.offsetWidth
        marked.setAttribute('data-settings-found', '')
        const done = marked
        unmark = window.setTimeout(() => done.removeAttribute('data-settings-found'), 2400)
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
        heading.focus({ preventScroll: true })
        forgetRequest()
      }
      const top = found?.getBoundingClientRect().top ?? null
      if (found && top !== last) found.scrollIntoView?.({ block: 'start' })
      last = found ? found.getBoundingClientRect().top : null
      if (++tries > 30) {
        window.clearInterval(timer)
        if (!found) pane.current?.scrollTo?.({ top: 0 })
      }
    }, 100)
    // Their own scrolling wins over ours.
    const stop = () => window.clearInterval(timer)
    const events = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const
    for (const name of events) window.addEventListener(name, stop, { once: true, passive: true })
    return () => {
      stop()
      window.clearTimeout(unmark)
      marked?.removeAttribute('data-settings-found')
      for (const name of events) window.removeEventListener(name, stop)
    }
  }, [location.key, title, pane, content])
}

/** Drops `settingsFind` from this history entry without a navigation, so the mark isn't undone. */
function forgetRequest() {
  const entry = window.history.state as { usr?: unknown } | null
  if (entry && typeof entry.usr === 'object' && entry.usr && 'settingsFind' in entry.usr) {
    const { settingsFind: _, ...usr } = entry.usr as Record<string, unknown>
    window.history.replaceState({ ...entry, usr: Object.keys(usr).length ? usr : null }, '')
  }
}
