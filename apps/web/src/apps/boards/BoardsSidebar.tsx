import { NavLink, useLocation } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { useNewBoard } from './useNewBoard'

/** Whiteboard's sidebar: new board, and the two lists. */
export function BoardsSidebar() {
  const { pathname, search } = useLocation()
  const scope = new URLSearchParams(search).get('scope') === 'team' ? 'team' : 'mine'
  const onList = pathname === '/boards'
  const { create, busy } = useNewBoard()
  return (
    <nav aria-label="Whiteboard" className="mt-1 flex flex-col gap-0.5 px-2">
      <button
        type="button"
        onClick={() => void create(scope === 'team' && onList)}
        disabled={busy}
        data-testid="boards-new"
        className="mb-2 flex h-9 items-center gap-2 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
      >
        <Icon name="plus" className="size-4" />
        New board
      </button>
      <Item to="/boards" icon="board" label="My boards" active={onList && scope === 'mine'} />
      <Item
        to="/boards?scope=team"
        icon="share"
        label="Team boards"
        active={onList && scope === 'team'}
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
