import { NavLink, useLocation } from 'react-router'
import { Icon } from '../../components/Icon'

/** Briefcast's sidebar: the latest episode; past ones are listed on the page. */
export function BriefcastSidebar() {
  const { pathname } = useLocation()
  const active = pathname === '/briefcast'
  return (
    <nav aria-label="Briefcast" className="mt-1 flex flex-col gap-0.5 px-2">
      <NavLink
        to="/briefcast"
        aria-current={active ? 'page' : undefined}
        className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-paper-sunk/70 hover:text-ink ${
          active ? 'bg-paper-sunk/80 text-ink' : 'text-ink-soft'
        }`}
      >
        <Icon name="headphones" className="size-4 text-ink-faint" />
        Latest briefing
      </NavLink>
    </nav>
  )
}
