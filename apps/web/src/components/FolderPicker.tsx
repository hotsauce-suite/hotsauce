import { useState } from 'react'
import { basename, DOCS_ROOT, dirname } from '../lib/paths'
import { useSession } from '../state/session'
import { useDirectory } from '../state/treeStore'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

interface FolderPickerProps {
  space: string
  title: string
  /** Button text; the folder is appended, e.g. "Move here". */
  confirmLabel: string
  initialFolder?: string
  /** Folders that can't be chosen (a folder can't move into itself). */
  disabled?: (folder: string) => boolean
  onConfirm: (folder: string) => Promise<void> | void
  onClose: () => void
}

/** Browse a space's docs/ folders one level at a time and pick one. */
export function FolderPicker({
  space,
  title,
  confirmLabel,
  initialFolder = DOCS_ROOT,
  disabled,
  onConfirm,
  onClose,
}: FolderPickerProps) {
  const { tree, spaceLabel } = useSession()
  const [folder, setFolder] = useState(initialFolder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entries = useDirectory(tree, space, folder)
  const subfolders = (entries ?? []).filter(
    (e) => e.type === 'dir' && !basename(e.path).startsWith('.'),
  )
  const crumbs = folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))
  const blocked = disabled?.(folder) ?? false

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm(folder)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work. Try again.')
      setBusy(false)
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <nav aria-label="Folder path" className="mb-2 flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, i) => (
          <span key={crumb} className="flex items-center gap-1">
            {i > 0 ? <Icon name="chevron" className="size-3 text-ink-faint" /> : null}
            <button
              type="button"
              onClick={() => setFolder(crumb)}
              className={`rounded px-1 ${crumb === folder ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'}`}
            >
              {i === 0 ? spaceLabel(space) : basename(crumb)}
            </button>
          </span>
        ))}
      </nav>
      <ul className="mb-4 max-h-64 min-h-24 overflow-y-auto rounded-lg border border-ash bg-paper p-1">
        {folder !== DOCS_ROOT ? (
          <li>
            <button
              type="button"
              onClick={() => setFolder(dirname(folder))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-ember-wash"
            >
              <Icon name="chevron" className="size-3.5 rotate-180" />
              Up one level
            </button>
          </li>
        ) : null}
        {entries === undefined ? (
          <li className="px-2 py-1.5 text-sm text-ink-faint">Loading folders…</li>
        ) : subfolders.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-ink-faint">No folders inside this one.</li>
        ) : (
          subfolders.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => setFolder(entry.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-ember-wash"
              >
                <Icon name="folder" className="size-4 text-ink-faint" />
                {basename(entry.path)}
              </button>
            </li>
          ))
        )}
      </ul>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={busy || blocked}
          className="rounded-lg bg-ember px-3.5 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
