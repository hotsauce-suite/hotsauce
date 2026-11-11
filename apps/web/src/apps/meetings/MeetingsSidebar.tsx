import { Link, useLocation } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { meetingUrl } from '../../lib/paths'
import { useSession } from '../../state/session'
import { dayLabel } from './format'
import { useMeetingList } from './useMeetingList'

const RECENT_COUNT = 10

/** Hearth Meetings' sidebar (inside the shell's SidebarFrame): start, browse, ask, recent notes. */
export function MeetingsSidebar({
  activeSpace,
  activePath,
  onOpenSearch,
}: {
  activeSpace: string | null
  activePath: string | null
  onOpenSearch: () => void
}) {
  const location = useLocation()
  const session = useSession()
  const list = useMeetingList({})
  const recent = list.meetings.slice(0, RECENT_COUNT)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <>
      <div className="px-3">
        <Link
          to="/meetings/start"
          className="flex h-9 items-center justify-center gap-2 rounded-lg bg-ember text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          <Icon name="mic" />
          New meeting
        </Link>
      </div>

      <button
        type="button"
        onClick={onOpenSearch}
        className="mx-3 mt-3 flex h-9 w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-ash bg-paper/70 px-3 text-sm text-ink-faint hover:border-ash-strong hover:text-ink-soft"
      >
        <Icon name="search" className="size-4" />
        <span className="flex-1 text-left">Search meetings and docs</span>
        <kbd className="font-mono text-[0.7rem] text-ink-faint">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <nav aria-label="Meetings" className="mt-3 px-2">
        <NavItem
          to="/meetings"
          icon="calendar"
          label="All meetings"
          active={location.pathname === '/meetings'}
        />
        <NavItem
          to="/meetings/ask"
          icon="chat"
          label="Ask across meetings"
          active={location.pathname === '/meetings/ask'}
        />
        <NavItem
          to="/meetings/extension"
          icon="tab"
          label="Chrome extension"
          active={location.pathname === '/meetings/extension'}
        />
      </nav>

      <section
        aria-label="Recent meetings"
        className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-ash/70 px-2 pt-2 pb-2"
      >
        <h3 className="px-2 pt-1 pb-1 text-xs font-semibold text-ink-faint">Recent</h3>
        {list.status === 'ready' && recent.length === 0 ? (
          <p className="px-2 text-xs text-ink-faint">Meetings you take notes in show up here.</p>
        ) : null}
        <ul>
          {recent.map((m) => {
            const active = m.space === activeSpace && m.path === activePath
            return (
              <li key={`${m.space}:${m.path}`}>
                <Link
                  to={meetingUrl(m.space, m.path)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm ${
                    active
                      ? 'bg-paper/70 text-ink'
                      : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <span className="shrink-0 text-[0.7rem] text-ink-faint">
                    {m.date ? dayLabel(new Date(m.date)) : session.spaceLabel(m.space)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}

function NavItem({
  to,
  icon,
  label,
  active,
}: {
  to: string
  icon: IconName
  label: string
  active: boolean
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-sm ${
        active
          ? 'bg-paper/70 font-medium text-ink'
          : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
      }`}
    >
      <Icon name={icon} className="size-4 text-ink-faint" />
      {label}
    </Link>
  )
}
