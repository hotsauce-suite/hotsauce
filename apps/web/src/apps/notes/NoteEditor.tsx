import {
  type ChecklistItem,
  checklistText,
  checklistToText,
  parseChecklist,
  textToChecklist,
} from '@hearth/format'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HearthApiError } from '../../api/client'
import { type NoteInput, type NoteView, notesApi } from '../../api/notes'
import { AttachmentChips, FilePicker } from '../../components/FilePicker'
import { below, Menu, type MenuAnchor } from '../../components/Menu'
import { ReadOnlyLinkItems, useReadOnlyLink } from '../../components/ReadOnlyLink'
import { ChecklistEditor } from './ChecklistEditor'
import { editedLabel } from './logic'
import { ColorPicker, LabelPicker, ToolButton } from './NoteTools'
import { errorMessage } from './useNotes'

export const SAVE_DELAY_MS = 700

interface Text {
  title: string
  body: string
}

/**
 * A note opened from the board: title and text (or checklist) saved as you type, with its color,
 * pin, labels, archive, delete, Move to Team and, on a checklist line, Make a task.
 */
export function NoteEditor({
  note: initial,
  teamSpace,
  labelSuggestions,
  compact,
  onSaved,
  onArchive,
  onTrash,
  onMoved,
  onMakeTask,
  onClose,
}: {
  note: NoteView
  /** The team space's name, for Move to Team; null hides it. */
  teamSpace: string | null
  labelSuggestions: readonly string[]
  compact: boolean
  onSaved: (note: NoteView) => void
  onArchive: (note: NoteView) => void
  onTrash: (note: NoteView) => void
  onMoved: (note: NoteView) => void
  onMakeTask: (note: NoteView, text: string) => void
  onClose: () => void
}) {
  const titleId = useId()
  const [note, setNote] = useState(initial)
  const [text, setText] = useState<Text>({ title: initial.title, body: initial.body })
  const [checklist, setChecklist] = useState(initial.checklist)
  const [items, setItems] = useState<ChecklistItem[]>(() => parseChecklist(initial.body) ?? [])
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)

  // Every write goes through one chain, in order; `base` is the version the text was edited from.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const base = useRef(initial.blobOid)
  const saved = useRef<Text>({ title: initial.title, body: initial.body })
  const pending = useRef<Text | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refused = useRef(false)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const write = useCallback(
    (patch: NoteInput, guarded = false) => {
      const run = chain.current.then(async () => {
        setSaving(true)
        try {
          // The base is read when this write runs, after the one before it has landed.
          const next = await notesApi.update(
            initial.space,
            initial.id,
            guarded ? { ...patch, baseBlobOid: base.current } : patch,
          )
          base.current = next.blobOid
          if (patch.title !== undefined || patch.body !== undefined) {
            saved.current = { title: next.title, body: next.body }
          }
          setNote(next)
          setError(null)
          onSavedRef.current(next)
          return next
        } catch (err) {
          if (err instanceof HearthApiError && err.status === 409) setConflict(true)
          else setError(errorMessage(err))
          throw err
        } finally {
          setSaving(false)
        }
      })
      chain.current = run.catch(() => {})
      return run
    },
    [initial.space, initial.id],
  )

  const flush = useCallback(
    /** Saves typing not yet saved; resolves to whether everything typed is saved. */
    (force = false): Promise<boolean> => {
      clearTimeout(timer.current)
      const t = pending.current
      if (!t) return chain.current.then(() => pending.current === null)
      pending.current = null
      if (t.title === saved.current.title && t.body === saved.current.body) {
        return chain.current.then(() => pending.current === null)
      }
      return write({ title: t.title, body: t.body }, !force).then(
        () => pending.current === null,
        () => {
          // Kept for a retry: the banner offers it.
          pending.current ??= t
          return false
        },
      )
    },
    [write],
  )

  const edit = (next: Text) => {
    setText(next)
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  const bodyOf = (list: boolean, list_items: ChecklistItem[], body: string) =>
    list ? checklistText(list_items) : body

  const close = useCallback(async () => {
    // A failed save keeps the editor open once, with its banner or error, so the typing isn't
    // lost unseen; closing again closes.
    if ((await flush()) || refused.current) onClose()
    else refused.current = true
  }, [flush, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) void close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  // Save what's typed if the page goes away.
  useEffect(() => () => void flush(), [flush])

  const takeTheirs = async () => {
    pending.current = null
    clearTimeout(timer.current)
    const fresh = await notesApi.get(initial.space, initial.id)
    base.current = fresh.blobOid
    saved.current = { title: fresh.title, body: fresh.body }
    setNote(fresh)
    setText({ title: fresh.title, body: fresh.body })
    setChecklist(fresh.checklist)
    setItems(parseChecklist(fresh.body) ?? [])
    setConflict(false)
    onSavedRef.current(fresh)
  }

  const keepMine = () => {
    setConflict(false)
    pending.current = { title: text.title, body: bodyOf(checklist, items, text.body) }
    void flush(true)
  }

  const toggleChecklist = () => {
    if (checklist) {
      const body = checklistToText(items)
      setChecklist(false)
      edit({ title: text.title, body })
    } else {
      const next = textToChecklist(text.body)
      setChecklist(true)
      setItems(next)
      edit({ title: text.title, body: checklistText(next) })
    }
  }

  const moveToTeam = async () => {
    if (!teamSpace) return
    await flush()
    try {
      onMoved(await notesApi.move(initial.space, initial.id, teamSpace))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center ${compact ? 'items-end' : 'items-start overflow-y-auto p-4 pt-[10vh]'}`}
    >
      <button
        type="button"
        aria-label="Close note"
        tabIndex={-1}
        className="fixed inset-0 cursor-default bg-paper-sunk/60 backdrop-blur-[2px]"
        onClick={() => void close()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="note-editor"
        {...(note.color ? { 'data-color': note.color } : {})}
        className={`note-surface relative flex w-full flex-col border shadow-float ${compact ? 'max-h-[92vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]' : 'max-h-[80vh] max-w-xl rounded-xl'}`}
      >
        <h2 id={titleId} className="sr-only">
          {text.title || 'Note'}
        </h2>
        {conflict ? (
          <div
            role="alert"
            className="m-3 mb-0 rounded-lg border border-ember/40 bg-ember-wash p-3 text-sm text-ink"
          >
            Someone else changed this note while you were editing.
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void takeTheirs()}
                className="rounded-md border border-ash-strong px-3 py-1 hover:border-ember"
              >
                Show theirs
              </button>
              <button
                type="button"
                data-testid="note-keep-mine"
                onClick={keepMine}
                className="rounded-md border border-ash-strong px-3 py-1 hover:border-ember"
              >
                Keep mine
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex items-start gap-1 px-4 pt-3">
          <input
            value={text.title}
            placeholder="Title"
            aria-label="Title"
            data-testid="note-editor-title"
            onChange={(e) =>
              edit({ title: e.target.value, body: bodyOf(checklist, items, text.body) })
            }
            className="min-w-0 flex-1 bg-transparent py-1 text-lg font-medium text-ink outline-none placeholder:text-ink-faint"
          />
          <ToolButton
            icon="pin"
            label={note.pinned ? 'Unpin' : 'Pin'}
            active={note.pinned}
            testId="note-editor-pin"
            onClick={() => void write({ pinned: !note.pinned }).catch(() => {})}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          {checklist ? (
            <ChecklistEditor
              items={items}
              onChange={(next) => {
                setItems(next)
                edit({ title: text.title, body: checklistText(next) })
              }}
              onMakeTask={(t) => onMakeTask(note, t)}
            />
          ) : (
            <textarea
              // biome-ignore lint/a11y/noAutofocus: an opened note is for typing into
              autoFocus={!compact}
              value={text.body}
              placeholder="Note"
              aria-label="Note"
              data-testid="note-editor-body"
              rows={Math.min(20, Math.max(4, text.body.split('\n').length + 1))}
              onChange={(e) => edit({ title: text.title, body: e.target.value })}
              className="w-full resize-none bg-transparent py-1 text-[0.95rem] text-ink outline-none placeholder:text-ink-faint"
            />
          )}
          {checklist ? null : <AttachmentChips text={text.body} className="mt-1" />}
          {note.labels.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {note.labels.map((l) => (
                <li key={l} className="rounded-full bg-ink/10 px-2 py-0.5 text-xs text-ink">
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-right text-[0.7rem] text-ink-faint" data-testid="note-saved">
            {saving ? 'Saving…' : editedLabel(note.updated)}
          </p>
          {error ? (
            <p role="alert" className="mt-1 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-0.5 border-t border-ink/10 px-2 py-1.5">
          <ColorPicker
            value={note.color}
            onChange={(color) => void write({ color }).catch(() => {})}
          />
          <LabelPicker
            value={note.labels}
            suggestions={labelSuggestions}
            onChange={(labels) => void write({ labels }).catch(() => {})}
          />
          <ToolButton
            icon={checklist ? 'notes' : 'checklist'}
            label={checklist ? 'Hide checkboxes' : 'Show checkboxes'}
            testId="note-editor-toggle-list"
            onClick={toggleChecklist}
          />
          {checklist ? null : (
            <ToolButton
              icon="paperclip"
              label="Attach a file"
              testId="note-editor-attach"
              onClick={() => setPicking(true)}
            />
          )}
          <NoteLinkButton space={note.space} path={note.path} before={flush} />
          <ToolButton
            icon="archive"
            label={note.archived ? 'Unarchive' : 'Archive'}
            testId="note-editor-archive"
            onClick={async () => {
              await flush()
              onArchive(note)
            }}
          />
          <ToolButton
            icon="trash"
            label="Delete"
            testId="note-editor-trash"
            onClick={async () => {
              await flush()
              onTrash(note)
            }}
          />
          {teamSpace && note.space !== teamSpace ? (
            <button
              type="button"
              data-testid="note-move-team"
              onClick={() => void moveToTeam()}
              className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-ink/10 hover:text-ink"
            >
              Move to Team
            </button>
          ) : null}
          <button
            type="button"
            data-testid="note-editor-close"
            onClick={() => void close()}
            className="ml-auto rounded-md px-4 py-1.5 text-sm font-medium text-ink hover:bg-ink/10"
          >
            Close
          </button>
        </div>
      </div>
      {picking ? (
        <FilePicker
          targetSpace={note.space}
          onClose={() => setPicking(false)}
          onPick={(a) => {
            setPicking(false)
            const body = text.body.replace(/\s+$/, '')
            edit({ title: text.title, body: body ? `${body}\n${a.markdown}` : a.markdown })
          }}
        />
      ) : null}
    </div>,
    document.body,
  )
}

/** The note's read-only link (ARCHITECTURE §20): make one, copy it, or turn it off. */
function NoteLinkButton({
  space,
  path,
  before,
}: {
  space: string
  path: string
  before: () => Promise<unknown>
}) {
  const link = useReadOnlyLink(space, path)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  return (
    <>
      <span ref={ref} className="inline-flex">
        <ToolButton
          icon="share"
          label="Read-only link"
          testId="note-editor-link"
          onClick={() => {
            if (!anchor) link.refresh()
            setAnchor(anchor || !ref.current ? null : below(ref.current))
          }}
        />
      </span>
      {anchor ? (
        <Menu anchor={anchor} label="Read-only link" onClose={() => setAnchor(null)}>
          <ReadOnlyLinkItems link={link} close={() => setAnchor(null)} before={before} />
        </Menu>
      ) : null}
    </>
  )
}
