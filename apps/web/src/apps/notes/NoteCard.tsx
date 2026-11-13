import { notePreview, parseChecklist } from '@hearth/format'
import { type NoteColor, type NoteView, noteKey } from '../../api/notes'
import { AttachmentChips, withoutAttachmentLinks } from '../../components/FilePicker'
import { daysLeftInTrash } from './logic'
import { ColorPicker, ToolButton } from './NoteTools'

const MAX_ITEMS = 8

export interface CardActions {
  open: (note: NoteView) => void
  tick: (note: NoteView, index: number, checked: boolean) => void
  pin: (note: NoteView) => void
  color: (note: NoteView, color: NoteColor | null) => void
  archive: (note: NoteView) => void
  trash: (note: NoteView) => void
  restore: (note: NoteView) => void
  deleteForever: (note: NoteView) => void
}

/** One note on the board: title, text or the first open items, labels, and tools on hover. */
export function NoteCard({
  note,
  order,
  team,
  actions,
}: {
  note: NoteView
  /** Its place in reading order on the board, for j and k. */
  order?: number
  /** Shows a "Team" chip: the note is in the shared space. */
  team: boolean
  actions: CardActions
}) {
  const items = note.checklist ? (parseChecklist(note.body) ?? []) : null
  const inTrash = note.trashed !== null
  const empty = !note.title && !note.body

  return (
    <article
      data-testid="note-card"
      data-note-id={note.id}
      data-note-key={noteKey(note)}
      data-list-row
      {...(note.color ? { 'data-color': note.color } : {})}
      className="note-card note-surface group relative rounded-xl border transition-shadow hover:shadow-float"
    >
      <button
        type="button"
        aria-label={`Open note ${note.title || notePreview(note.body, 40) || 'Empty note'}`}
        data-testid="note-card-open"
        data-list-item
        data-list-order={order}
        onClick={() => actions.open(note)}
        className="absolute inset-0 rounded-xl"
      />
      <div className={`pointer-events-none relative px-4 pt-3 pb-1 ${note.title ? '' : 'pr-9'}`}>
        {note.title ? (
          <h3 data-testid="note-card-title" className="mb-1 pr-6 font-medium break-words text-ink">
            {note.title}
          </h3>
        ) : null}
        {items ? (
          <ul className="space-y-0.5">
            {items.slice(0, MAX_ITEMS).map((item, i) =>
              item.checked ? null : (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: an item's place is its identity here
                  key={i}
                  className="flex items-start gap-2 text-[0.9rem] text-ink"
                >
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={inTrash}
                    aria-label={`Tick ${item.text}`}
                    data-testid="note-card-tick"
                    onChange={() => actions.tick(note, i, true)}
                    className="pointer-events-auto mt-1 size-3.5 shrink-0 accent-[var(--ember)]"
                  />
                  <span className="min-w-0 break-words">{item.text}</span>
                </li>
              ),
            )}
            {items.slice(0, MAX_ITEMS).some((i) => i.checked) || items.length > MAX_ITEMS ? (
              <li className="pt-0.5 text-xs text-ink-faint">{tickedSummary(items, MAX_ITEMS)}</li>
            ) : null}
          </ul>
        ) : note.body ? (
          <div
            data-testid="note-card-body"
            className="max-h-[22rem] overflow-hidden text-[0.9rem] break-words whitespace-pre-wrap text-ink"
          >
            {withoutAttachmentLinks(notePreview(note.body, 1200))}
          </div>
        ) : empty ? (
          <p className="text-[0.95rem] text-ink-faint">Empty note</p>
        ) : null}
        {note.checklist ? null : (
          <AttachmentChips text={note.body} className="pointer-events-auto relative mt-2" />
        )}
        {note.labels.length > 0 || team ? (
          <ul className="mt-2 flex flex-wrap gap-1">
            {team ? (
              <li className="rounded-full border border-ink/15 px-2 py-0.5 text-[0.7rem] text-ink-soft">
                Team
              </li>
            ) : null}
            {note.labels.map((l) => (
              <li key={l} className="rounded-full bg-ink/10 px-2 py-0.5 text-[0.7rem] text-ink">
                {l}
              </li>
            ))}
          </ul>
        ) : null}
        {inTrash && note.trashed ? (
          <p className="mt-2 text-[0.7rem] text-ink-faint">
            Deleted for good in {daysLeftInTrash(note.trashed)} days
          </p>
        ) : null}
      </div>

      {inTrash ? null : (
        <div className="note-card-tools absolute top-1.5 right-1.5 opacity-0">
          <ToolButton
            icon="pin"
            label={note.pinned ? 'Unpin' : 'Pin'}
            active={note.pinned}
            testId="note-card-pin"
            onClick={() => actions.pin(note)}
          />
        </div>
      )}
      <div className="note-card-tools relative flex items-center gap-0.5 px-2 pb-1.5 opacity-0">
        {inTrash ? (
          <>
            <ToolButton
              icon="restore"
              label="Restore"
              testId="note-card-restore"
              onClick={() => actions.restore(note)}
            />
            <ToolButton
              icon="trash"
              label="Delete forever"
              testId="note-card-delete"
              onClick={() => actions.deleteForever(note)}
            />
          </>
        ) : (
          <>
            <ColorPicker value={note.color} onChange={(c) => actions.color(note, c)} />
            <ToolButton
              icon="archive"
              label={note.archived ? 'Unarchive' : 'Archive'}
              testId="note-card-archive"
              onClick={() => actions.archive(note)}
            />
            <ToolButton
              icon="trash"
              label="Delete"
              testId="note-card-trash"
              onClick={() => actions.trash(note)}
            />
          </>
        )}
      </div>
    </article>
  )
}

function tickedSummary(items: { checked: boolean }[], shown: number): string {
  const ticked = items.filter((i) => i.checked).length
  const hiddenOpen = items.slice(shown).filter((i) => !i.checked).length
  const parts: string[] = []
  if (hiddenOpen > 0) parts.push(`+${hiddenOpen} more`)
  if (ticked > 0) parts.push(`${ticked} ticked`)
  return parts.join(' · ')
}
