import { NavLink, useLocation } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { useSession } from '../../state/session'
import { filesBus } from './bus'

/** Hearth Files' sidebar: upload, then Team files, My files and Recent. */
export function FilesSidebar() {
  const { pathname, search } = useLocation()
  const session = useSession()
  const personal = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  const space = new URLSearchParams(search).get('space') ?? 'team'
  const browsing = pathname === '/files'
  return (
    <nav aria-label="Files" className="mt-1 flex flex-col gap-0.5 px-2">
      <button
        type="button"
        data-testid="files-upload-sidebar"
        onClick={() => filesBus.emit({ type: 'pick-upload' })}
        className="mb-2 flex h-9 items-center gap-2 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong"
      >
        <Icon name="upload" className="size-4" />
        Upload files
      </button>
      <Item to="/files" icon="share" label="Team files" active={browsing && space === 'team'} />
      {personal ? (
        <Item
          to={`/files?space=${encodeURIComponent(personal)}`}
          icon="folder"
          label="My files"
          active={browsing && space === personal}
        />
      ) : null}
      <Item
        to="/files/recent"
        icon="history"
        label="Recent"
        active={pathname === '/files/recent'}
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
