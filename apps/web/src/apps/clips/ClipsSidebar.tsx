import { NavLink, useLocation } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'

/** Hearth Clips' sidebar: record, and the two lists. */
export function ClipsSidebar() {
  const { pathname, search } = useLocation()
  const scope = new URLSearchParams(search).get('scope') === 'team' ? 'team' : 'mine'
  const onLibrary = pathname === '/clips'
  return (
    <nav aria-label="Clips" className="mt-1 flex flex-col gap-0.5 px-2">
      <NavLink
        to="/clips/new"
        data-testid="clips-new"
        className="mb-2 flex h-9 items-center gap-2 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong"
      >
        <span className="size-2.5 rounded-full bg-paper-raised" aria-hidden="true" />
        Record a clip
      </NavLink>
      <Item to="/clips" icon="video" label="My clips" active={onLibrary && scope === 'mine'} />
      <Item
        to="/clips?scope=team"
        icon="share"
        label="Team clips"
        active={onLibrary && scope === 'team'}
      />
    </nav>
  )
}

function Item({
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
    <NavLink
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-paper-sunk/70 hover:text-ink ${
        active ? 'bg-paper-sunk/80 text-ink' : 'text-ink-soft'
      }`}
    >
      <Icon name={icon} className="size-4 text-ink-faint" />
      {label}
    </NavLink>
  )
}
