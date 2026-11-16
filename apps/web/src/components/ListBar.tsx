import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Icon } from './Icon'

/**
 * The one row above every list (docs/PLAN-consistency.md, requirement 12): the list's tabs on
 * the left, its search on the right. On a phone the search drops under the tabs, full width.
 */

export interface ListTab<T extends string = string> {
  id: T
  label: string
  /** A tab that is its own address (Tasks' lists) is a link, not a button. */
  to?: string
  testId?: string
}

export interface ListSearch {
  value: string
  onChange: (value: string) => void
  /** What a screen reader calls the field, e.g. "Search forms". */
  label: string
  placeholder?: string
  testId: string
  /** Enter, where a search waits for it. */
  onSubmit?: () => void
}

interface ListBarProps<T extends string> {
  tabs?: readonly ListTab<T>[]
  /** The selected tab; null when the list on screen is none of them. */
  tab?: T | null
  onTab?: (id: T) => void
  /** What a screen reader calls the tabs, e.g. "Whose boards". */
  tabsLabel?: string
  search?: ListSearch
  /** In place of tabs, where a list has something else on the left (Files' folder path). */
  children?: ReactNode
  className?: string
}

export function ListBar<T extends string>({
  tabs,
  tab,
  onTab,
  tabsLabel,
  search,
  children,
  className = 'mb-5',
}: ListBarProps<T>) {
  return (
    <div data-testid="list-bar" className={`flex flex-wrap items-center gap-3 ${className}`}>
      {tabs ? (
        <div
          role="tablist"
          aria-label={tabsLabel}
          data-testid="list-tabs"
          className="clips-tabs max-w-full overflow-x-auto"
        >
          {tabs.map((t) =>
            t.to ? (
              <Link
                key={t.id}
                to={t.to}
                role="tab"
                aria-selected={tab === t.id}
                data-testid={t.testId}
              >
                {t.label}
              </Link>
            ) : (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                data-testid={t.testId}
                onClick={() => onTab?.(t.id)}
              >
                {t.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      {children}
      {search ? (
        <form
          data-testid="list-search"
          className="relative ml-auto w-full sm:w-72"
          onSubmit={(e) => {
            e.preventDefault()
            search.onSubmit?.()
          }}
        >
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search'}
            aria-label={search.label}
            data-testid={search.testId}
            className="h-9 w-full rounded-lg border border-ash bg-paper-raised pr-3 pl-9 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
          />
        </form>
      ) : null}
    </div>
  )
}

/**
 * The two widths a list page comes in (requirement 17): rows of text read best in one centered
 * column; cards run as wide as the window allows.
 */
const WIDTHS = { reading: 'max-w-3xl', gallery: 'max-w-6xl' } as const

export function ListColumn({
  width,
  children,
  className = '',
}: {
  width: keyof typeof WIDTHS
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-list-width={width}
      className={`mx-auto w-full ${WIDTHS[width]} px-4 pt-5 pb-24 md:px-8 ${className}`}
    >
      {children}
    </div>
  )
}

/** The one size for a heading inside a list page (a section, or a view that is not a tab). */
export const listHeading =
  'font-display text-lg leading-tight font-semibold tracking-tight text-ink'

export type Scope = 'all' | 'mine' | 'team'

const SCOPE_LABEL: Record<Scope, string> = { all: 'All', mine: 'Personal', team: 'Team' }

/** Personal / Team tabs, with "All" first where a list shows both on arrival. */
export const scopeTabs = <S extends Scope>(ids: readonly S[], app: string): ListTab<S>[] =>
  ids.map((id) => ({ id, label: SCOPE_LABEL[id], testId: `${app}-scope-${id}` }))

/** The tab chosen, kept in the address (`?scope=team`) so a reload and a shared link keep it. */
export function useScope<S extends Scope>(ids: readonly S[]): [S, (next: S) => void] {
  const [params, setParams] = useSearchParams()
  const first = ids[0] as S
  const asked = params.get('scope') as S | null
  const scope = asked && ids.includes(asked) ? asked : first
  const setScope = (next: S) => {
    const p = new URLSearchParams(params)
    if (next === first) p.delete('scope')
    else p.set('scope', next)
    setParams(p, { replace: true })
  }
  return [scope, setScope]
}

/** Whether an item in `space` belongs under the chosen tab. */
export const inScope = (scope: Scope, space: string, teamSpace: string | null) =>
  scope === 'all' || (scope === 'team') === (space === teamSpace)

/** "Filter this list by name": every word typed appears somewhere in the name. */
export function matchesName(name: string, query: string): boolean {
  const hay = name.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}
