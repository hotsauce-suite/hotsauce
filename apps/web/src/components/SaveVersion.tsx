import { useState } from 'react'
import type { CommitOutcome } from '../hooks/useDocument'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

/** "Save version": commit now, with an optional label that names the version in history. */
export function SaveVersion({
  onSave,
  iconOnly = false,
}: {
  onSave: (label: string) => Promise<CommitOutcome>
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    await onSave(label.trim())
    setBusy(false)
    setOpen(false)
    setLabel('')
  }

  return (
    <>
      <button
        type="button"
        data-testid="save-version"
        onClick={() => setOpen(true)}
        aria-label={iconOnly ? 'Save version' : undefined}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink"
      >
        <Icon name="flag" />
        {iconOnly ? null : 'Save version'}
      </button>
      {open ? (
        <Dialog title="Save version" onClose={() => setOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <label htmlFor="version-label" className="mb-1.5 block text-sm text-ink-soft">
              Name this version (optional)
            </label>
            <input
              id="version-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Sent to the board"
              className="mb-5 h-10 w-full rounded-lg border border-ash bg-paper px-3 text-ink outline-none focus:border-ember"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-ember px-3.5 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save version'}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  )
}
