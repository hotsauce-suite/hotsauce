import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router'
import type { AppManifest } from '../apps/registry'
import { displayName, docUrl } from '../lib/paths'
import { useSession } from '../state/session'
import { FileTree } from './FileTree'
import { Icon } from './Icon'
import { SpaceSwitcher } from './SpaceSwitcher'

/** What every app's sidebar shares: the hearth glow and the app's name. Apps, Settings and the account live in the rail. */
export function SidebarFrame({ app, children }: { app: AppManifest; children: ReactNode }) {
  return (
    <aside
      data-testid="sidebar"
      className="shell-sidebar relative isolate flex h-full min-h-0 flex-col overflow-clip border-r border-ash bg-paper-sunk"
    >
      {/* The hearth: warmth gathered at the foot of the sidebar. */}
      <div
        aria-hidden="true"
        className="hearth-glow pointer-events-none absolute -bottom-24 -left-16 -z-10 size-80 rounded-full opacity-80 blur-2xl"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--glow) 34%, transparent), color-mix(in oklab, var(--ember) 10%, transparent) 45%, transparent 70%)',
        }}
      />

      <h2
        data-testid="sidebar-app-name"
        className="shrink-0 px-4 pt-4 pb-2.5 font-display text-[1.06rem] leading-tight font-semibold tracking-tight text-ink"
      >
        {app.name}
      </h2>

      {children}
    </aside>
  )
}

interface SidebarProps {
  activeSpace: string | null
  activePath: string | null
  onOpenSearch: () => void
}

/** Hearth Docs' sidebar, inside the shell's SidebarFrame. */
export function Sidebar({ activeSpace, activePath, onOpenSearch }: SidebarProps) {
  const session = useSession()
  const recents = session.recents.slice(0, 6)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <>
      <SpaceSwitcher spaces={session.spaces} current={session.space} onChange={session.setSpace} />

      <button
        type="button"
        onClick={onOpenSearch}
        className="mx-3 mt-3 mb-2 flex h-9 items-center gap-2 rounded-lg border border-ash bg-paper/70 px-3 text-sm text-ink-faint hover:border-ash-strong hover:text-ink-soft"
      >
        <Icon name="search" className="size-4" />
        <span className="flex-1 text-left">Search docs and meetings</span>
        <kbd className="font-mono text-[0.7rem] text-ink-faint">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <NavLink
        to="/pages"
        data-testid="sidebar-pages"
        className={({ isActive }) =>
          `mx-3 mb-1 flex h-8 items-center gap-2 rounded-lg px-2 text-sm hover:bg-paper/70 hover:text-ink ${isActive ? 'bg-paper/70 text-ink' : 'text-ink-soft'}`
        }
      >
        <Icon name="book" className="size-4" />
        Pages
        <span className="ml-auto text-[0.7rem] text-ink-faint">from Claude</span>
      </NavLink>

      <FileTree
        key={session.space}
        space={session.space}
        activePath={activeSpace === session.space ? activePath : null}
      />

      <div className="h-52 shrink-0 overflow-y-auto border-t border-ash/70 px-2 pt-2 pb-2">
        <SidebarList
          title="Starred"
          empty="Star a doc to keep it here."
          items={session.stars.map((s) => ({ ...s, label: s.title ?? displayName(s.path) }))}
          activeSpace={activeSpace}
          activePath={activePath}
          spaceLabel={session.spaceLabel}
        />
        <SidebarList
          title="Recent"
          empty="Docs you open show up here."
          items={recents.map((r) => ({ ...r, label: r.title ?? displayName(r.path) }))}
          activeSpace={activeSpace}
          activePath={activePath}
          spaceLabel={session.spaceLabel}
        />
      </div>
    </>
  )
}

function SidebarList({
  title,
  empty,
  items,
  activeSpace,
  activePath,
  spaceLabel,
}: {
  title: string
  empty: string
  items: Array<{ space: string; path: string; label: string }>
  activeSpace: string | null
  activePath: string | null
  spaceLabel: (space: string) => string
}) {
  return (
    <section aria-label={title} className="mb-2">
      <h3 className="px-2 pt-1 pb-1 text-xs font-semibold text-ink-faint">{title}</h3>
      {items.length === 0 ? (
        <p className="px-2 pb-1 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => {
            const active = item.space === activeSpace && item.path === activePath
            return (
              <li key={`${item.space}:${item.path}`}>
                <Link
                  to={docUrl(item.space, item.path)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-sm ${
                    active ? 'text-ink' : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="shrink-0 text-[0.7rem] text-ink-faint">
                    {spaceLabel(item.space)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
