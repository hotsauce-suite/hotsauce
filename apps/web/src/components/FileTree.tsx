import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import type { Entry } from '../api/types'
import { saveOpenDocUnder } from '../lib/openDoc'
import {
  basename,
  DOCS_ROOT,
  dirname,
  displayName,
  docUrl,
  IMPORT_ACCEPT,
  isMarkdown,
  joinPath,
} from '../lib/paths'
import { useSession } from '../state/session'
import { untitledDocPath, useDirectory } from '../state/treeStore'
import { Dialog } from './Dialog'
import { FolderPicker } from './FolderPicker'
import { Icon } from './Icon'
import { Menu, type MenuAnchor, MenuItem } from './Menu'

const DRAG_TYPE = 'application/x-hearth-path'

// @hearth/format brings yaml with it; the sidebar paints from the entry chunk, so it loads the
// format only when a name is actually turned into a slug.
const slugify = async (name: string) => (await import('@hearth/format')).slugify(name)

type Editing = { kind: 'rename'; entry: Entry } | { kind: 'new-folder'; dir: string } | null
type Pending = { kind: 'move' | 'delete'; entry: Entry } | null

function ancestors(path: string): string[] {
  const dirs: string[] = []
  for (let dir = dirname(path); dir && dir !== DOCS_ROOT; dir = dirname(dir)) dirs.push(dir)
  return dirs
}

function isVisible(entry: Entry): boolean {
  if (basename(entry.path).startsWith('.')) return false
  return entry.type === 'dir' || isMarkdown(entry.path)
}

/** Replaces `from` (a file or folder) with `to` at the start of `path`, if it's inside. */
function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length)
  return null
}

export function FileTree({ space, activePath }: { space: string; activePath: string | null }) {
  const { tree, notify } = useSession()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestors(activePath ?? '')))
  const [editing, setEditing] = useState<Editing>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entry: Entry | null } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // Opening a doc (from search, a link) reveals it in the tree.
  useEffect(() => {
    if (!activePath) return
    setExpanded((current) => {
      const missing = ancestors(activePath).filter((dir) => !current.has(dir))
      return missing.length ? new Set([...current, ...missing]) : current
    })
  }, [activePath])

  const toggle = (dir: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  const fail = (err: unknown, fallback: string) =>
    notify(err instanceof Error && err.message ? err.message : fallback)

  /** "New doc" opens an untitled doc; nothing is committed until the first save. */
  const newDoc = async (dir: string) => {
    const path = await untitledDocPath(tree, space, dir)
    navigate(docUrl(space, path), { state: { newDoc: true } })
  }

  // Import: a hidden file picker, aimed at the folder the member chose.
  const importInput = useRef<HTMLInputElement>(null)
  const importDir = useRef(DOCS_ROOT)
  const chooseImport = (dir: string) => {
    importDir.current = dir
    importInput.current?.click()
  }
  const importChosen = async (files: File[]) => {
    if (files.length === 0) return
    const dir = importDir.current
    notify(files.length === 1 ? `Importing ${files[0]?.name}…` : `Importing ${files.length} files…`)
    const { importFiles } = await import('../lib/importDoc')
    const { paths, errors } = await importFiles(files, { space, dir, tree })
    for (const error of errors) notify(error)
    if (paths.length > 1) notify(`Imported ${paths.length} docs.`)
    setExpanded((current) => new Set([...current, dir]))
    const last = paths.at(-1)
    if (last) navigate(docUrl(space, last))
  }

  const createFolder = async (dir: string, name: string) => {
    setEditing(null)
    if (!name.trim()) return
    const path = joinPath(dir, await slugify(name))
    try {
      await api.createFolder(space, path)
      tree.refreshPaths(space, [`${path}/.gitkeep`])
      setExpanded((current) => new Set([...current, dir, path]))
    } catch (err) {
      fail(err, 'Couldn’t create the folder.')
    }
  }

  const relocate = async (entry: Entry, to: string) => {
    if (to === entry.path) return
    try {
      if (!(await saveOpenDocUnder(space, entry.path))) {
        notify('Save or resolve the open doc first, then move it.')
        return
      }
      await api.move(space, entry.path, to)
      tree.refreshPaths(space, [entry.path, to])
      const next = activePath ? movedPath(activePath, entry.path, to) : null
      if (next) navigate(docUrl(space, next), { replace: true })
    } catch (err) {
      fail(err, 'Couldn’t move that.')
    }
  }

  const rename = async (entry: Entry, name: string) => {
    setEditing(null)
    if (!name.trim()) return
    const slug = await slugify(name)
    const to = joinPath(dirname(entry.path), entry.type === 'dir' ? slug : `${slug}.md`)
    await relocate(entry, to)
  }

  const moveInto = (entry: Entry, folder: string) => {
    if (folder === entry.path || folder.startsWith(`${entry.path}/`)) return
    void relocate(entry, joinPath(folder, basename(entry.path)))
  }

  const remove = async (entry: Entry) => {
    setPending(null)
    try {
      if (!(await saveOpenDocUnder(space, entry.path))) {
        notify('Save or resolve the open doc first, then delete it.')
        return
      }
      await api.deleteFile(space, entry.path)
      tree.refreshPaths(space, [entry.path])
      if (activePath && movedPath(activePath, entry.path, '') !== null) navigate('/docs')
      notify(`Moved “${displayName(entry.path)}” to the trash.`)
    } catch (err) {
      fail(err, 'Couldn’t delete that.')
    }
  }

  const folderOf = (entry: Entry | null) =>
    entry ? (entry.type === 'dir' ? entry.path : dirname(entry.path)) : DOCS_ROOT

  const openMenu = (anchor: MenuAnchor, entry: Entry | null) => setMenu({ anchor, entry })

  const dropProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget(folder)
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setDropTarget(null)
      const raw = event.dataTransfer.getData(DRAG_TYPE)
      if (!raw) return
      const entry = JSON.parse(raw) as Entry
      moveInto(entry, folder)
    },
  })

  const renderLevel = (dir: string, depth: number) => (
    <TreeLevel
      key={dir}
      space={space}
      dir={dir}
      depth={depth}
      renderRow={(entry) => {
        const isDir = entry.type === 'dir'
        const open = isDir && expanded.has(entry.path)
        const active = entry.path === activePath
        const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path
        return (
          <li key={entry.path} role="none">
            {isRenaming ? (
              <NameInput
                depth={depth}
                initial={isDir ? basename(entry.path) : displayName(entry.path)}
                label={`Rename ${basename(entry.path)}`}
                onSubmit={(name) => void rename(entry, name)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div
                role="treeitem"
                tabIndex={0}
                data-testid="tree-item"
                data-path={entry.path}
                aria-level={depth + 1}
                aria-expanded={isDir ? open : undefined}
                aria-current={active ? 'page' : undefined}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(entry))
                  event.dataTransfer.effectAllowed = 'move'
                }}
                {...(isDir ? dropProps(entry.path) : {})}
                onClick={() => (isDir ? toggle(entry.path) : navigate(docUrl(space, entry.path)))}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (isDir) toggle(entry.path)
                    else navigate(docUrl(space, entry.path))
                  } else if (isDir && event.key === 'ArrowRight' && !open) toggle(entry.path)
                  else if (isDir && event.key === 'ArrowLeft' && open) toggle(entry.path)
                  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    openMenu({ x: rect.left + 24, y: rect.bottom }, entry)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openMenu({ x: event.clientX, y: event.clientY }, entry)
                }}
                style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
                className={`group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-[0.9rem] select-none ${
                  active
                    ? 'bg-ember-wash font-medium text-ink'
                    : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
                } ${dropTarget === entry.path ? 'ring-1 ring-ember' : ''}`}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded bg-ember"
                  />
                ) : null}
                <span className="flex size-4 shrink-0 items-center justify-center text-ink-faint">
                  {isDir ? (
                    <Icon
                      name="chevron"
                      className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                  ) : null}
                </span>
                <Icon name={isDir ? 'folder' : 'file'} className="size-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">
                  {isDir ? basename(entry.path) : displayName(entry.path)}
                </span>
                <button
                  type="button"
                  aria-label={`Actions for ${basename(entry.path)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    openMenu({ x: rect.left, y: rect.bottom + 4 }, entry)
                  }}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-paper-sunk hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Icon name="more" className="size-4" />
                </button>
              </div>
            )}
            {open ? renderLevel(entry.path, depth + 1) : null}
          </li>
        )
      }}
      after={
        editing?.kind === 'new-folder' && editing.dir === dir ? (
          <li role="none">
            <NameInput
              depth={depth}
              initial=""
              label="New folder name"
              placeholder="Folder name"
              onSubmit={(name) => void createFolder(dir, name)}
              onCancel={() => setEditing(null)}
            />
          </li>
        ) : null
      }
    />
  )

  const menuEntry = menu?.entry ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1">
        <button
          type="button"
          data-testid="new-doc"
          onClick={() => void newDoc(activePath ? dirname(activePath) : DOCS_ROOT)}
          className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-ink hover:bg-paper/70"
        >
          <Icon name="plus" className="size-4 text-ember" />
          New doc
        </button>
        <button
          type="button"
          data-testid="new-folder"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            const dir = activePath ? dirname(activePath) : DOCS_ROOT
            setExpanded((current) => new Set([...current, dir]))
            setEditing({ kind: 'new-folder', dir })
          }}
          className="flex size-8 items-center justify-center rounded-md text-ink-soft hover:bg-paper/70 hover:text-ink"
        >
          <Icon name="folderPlus" className="size-4" />
        </button>
        <button
          type="button"
          data-testid="import-docs"
          aria-label="Import docs"
          title="Import Markdown, Word or HTML files"
          onClick={() => chooseImport(activePath ? dirname(activePath) : DOCS_ROOT)}
          className="flex size-8 items-center justify-center rounded-md text-ink-soft hover:bg-paper/70 hover:text-ink"
        >
          <Icon name="upload" className="size-4" />
        </button>
        <input
          ref={importInput}
          type="file"
          multiple
          accept={IMPORT_ACCEPT}
          data-testid="import-input"
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void importChosen(files)
          }}
        />
      </div>
      <div
        data-testid="file-tree"
        role="tree"
        aria-label="Docs"
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-3 ${dropTarget === DOCS_ROOT ? 'bg-ember-wash/50' : ''}`}
        {...dropProps(DOCS_ROOT)}
        onContextMenu={(event) => {
          event.preventDefault()
          openMenu({ x: event.clientX, y: event.clientY }, null)
        }}
      >
        {renderLevel(DOCS_ROOT, 0)}
      </div>

      {menu ? (
        <Menu anchor={menu.anchor} label="Doc actions" onClose={() => setMenu(null)}>
          <MenuItem
            icon="plus"
            onSelect={() => {
              setMenu(null)
              void newDoc(folderOf(menuEntry))
            }}
          >
            New doc
          </MenuItem>
          <MenuItem
            icon="folderPlus"
            onSelect={() => {
              setMenu(null)
              const dir = folderOf(menuEntry)
              setExpanded((current) => new Set([...current, dir]))
              setEditing({ kind: 'new-folder', dir })
            }}
          >
            New folder
          </MenuItem>
          <MenuItem
            icon="upload"
            onSelect={() => {
              setMenu(null)
              chooseImport(folderOf(menuEntry))
            }}
          >
            Import here…
          </MenuItem>
          {menuEntry ? (
            <>
              <MenuItem
                icon="pencil"
                onSelect={() => {
                  setMenu(null)
                  setEditing({ kind: 'rename', entry: menuEntry })
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon="move"
                onSelect={() => {
                  setMenu(null)
                  setPending({ kind: 'move', entry: menuEntry })
                }}
              >
                Move to…
              </MenuItem>
              <MenuItem
                icon="trash"
                danger
                onSelect={() => {
                  setMenu(null)
                  setPending({ kind: 'delete', entry: menuEntry })
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : null}
        </Menu>
      ) : null}

      {pending?.kind === 'move' ? (
        <FolderPicker
          space={space}
          title={`Move “${basename(pending.entry.path)}”`}
          confirmLabel="Move here"
          initialFolder={dirname(pending.entry.path) || DOCS_ROOT}
          disabled={(folder) =>
            folder === dirname(pending.entry.path) ||
            folder === pending.entry.path ||
            folder.startsWith(`${pending.entry.path}/`)
          }
          onConfirm={async (folder) => {
            setPending(null)
            moveInto(pending.entry, folder)
          }}
          onClose={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'delete' ? (
        <Dialog title="Move to trash?" onClose={() => setPending(null)}>
          <p className="mb-5 text-sm text-ink-soft">
            “{basename(pending.entry.path)}” moves to the space’s trash folder. It stays in the
            history, so it can be restored.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-lg px-3 py-2 text-sm text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void remove(pending.entry)}
              className="rounded-lg bg-ember px-3.5 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong"
            >
              Move to trash
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function TreeLevel({
  space,
  dir,
  depth,
  renderRow,
  after,
}: {
  space: string
  dir: string
  depth: number
  renderRow: (entry: Entry) => ReactNode
  after: ReactNode
}) {
  const { tree } = useSession()
  const entries = useDirectory(tree, space, dir)
  if (entries === undefined) {
    return (
      <ul role="none" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            role="none"
            style={{ paddingLeft: `${1.4 + depth * 0.9}rem` }}
            className="flex h-8 items-center"
          >
            <span className="h-2.5 rounded-full bg-ash/70" style={{ width: `${55 - i * 12}%` }} />
          </li>
        ))}
      </ul>
    )
  }
  const visible = entries.filter(isVisible)
  return (
    <ul role="none">
      {visible.map(renderRow)}
      {after}
      {visible.length === 0 && !after && depth === 0 ? (
        <li role="none" className="px-3 py-2 text-sm text-ink-faint">
          No docs here yet. Start one with New doc.
        </li>
      ) : null}
    </ul>
  )
}

function NameInput({
  depth,
  initial,
  label,
  placeholder,
  onSubmit,
  onCancel,
}: {
  depth: number
  initial: string
  label: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  // Enter submits and unmounts the input; don't let the blur that follows submit twice.
  const done = useRef(false)
  const finish = (submit: boolean) => {
    if (done.current) return
    done.current = true
    if (submit) onSubmit(value)
    else onCancel()
  }
  return (
    <form
      style={{ paddingLeft: `${1.4 + depth * 0.9}rem` }}
      className="flex h-8 items-center pr-1"
      onSubmit={(event) => {
        event.preventDefault()
        finish(true)
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: inline rename starts typing immediately, like a file manager.
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => finish(value.trim() !== '' && value !== initial)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') finish(false)
        }}
        className="h-7 w-full rounded-md border border-ember bg-paper-raised px-2 text-sm text-ink outline-none"
      />
    </form>
  )
}
