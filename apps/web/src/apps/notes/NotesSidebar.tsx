import { Link, useLocation, useNavigate } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { labelUrl } from './logic'
import { notesBus, useNoteLabels } from './useNotes'

/** Hearth Notes' sidebar: New note, the board, labels, Archive, Trash, import. */
export function NotesSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const labels = useNoteLabels()

  const newNote = () => {
    if (pathname === '/notes' || pathname.startsWith('/notes/label/')) {
      notesBus.emit({ type: 'new-note' })
    } else {
      navigate('/notes', { state: { newNote: true } })
    }
  }

  return (
    <>
      <div className="px-3">
        <button
          type="button"
          data-testid="notes-sidebar-new"
          onClick={newNote}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-ember text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          <Icon name="plus" />
          New note
        </button>
      </div>

      <nav aria-label="Note views" className="mt-3 px-2">
        <NavItem to="/notes" icon="notes" label="Notes" active={pathname === '/notes'} />
      </nav>

      <section
        aria-label="Labels"
        className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-ash/70 px-2 pt-2 pb-2"
      >
        <h3 className="px-2 pt-1 pb-1 text-xs font-semibold text-ink-faint">Labels</h3>
        {labels.length === 0 ? (
          <p className="px-2 text-xs text-ink-faint">Add a label to a note and it shows up here.</p>
        ) : (
          <ul>
            {labels.map((l) => {
              const to = labelUrl(l.name)
              return (
                <li key={l.name}>
                  <NavItem
                    to={to}
                    icon="tag"
                    label={l.name}
                    count={l.count}
                    testId="notes-nav-label"
                    active={decodeURIComponent(pathname) === decodeURIComponent(to)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="shrink-0 border-t border-ash/70 px-2 py-2">
        <NavItem
          to="/notes/archive"
          icon="archive"
          label="Archive"
          testId="notes-nav-archive"
          active={pathname === '/notes/archive'}
        />
        <NavItem
          to="/notes/trash"
          icon="trash"
          label="Trash"
          testId="notes-nav-trash"
          active={pathname === '/notes/trash'}
        />
        <NavItem
          to="/notes/import"
          icon="upload"
          label="Import from Google Keep"
          active={pathname === '/notes/import'}
        />
      </div>
    </>
  )
}

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  testId,
}: {
  to: string
  icon: IconName
  label: string
  active: boolean
  count?: number | null
  testId?: string
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-sm ${
        active
          ? 'bg-paper/70 font-medium text-ink'
          : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
      }`}
    >
      <Icon name={icon} className="size-4 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className="shrink-0 text-[0.72rem] text-ink-faint tabular-nums">{count}</span>
      ) : null}
    </Link>
  )
}
