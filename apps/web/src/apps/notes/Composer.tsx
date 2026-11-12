import {
  type ChecklistItem,
  checklistText,
  checklistToText,
  type NoteColor,
  textToChecklist,
} from '@hearth/format'
import { useEffect, useRef, useState } from 'react'
import type { NoteInput } from '../../api/notes'
import { ChecklistEditor } from './ChecklistEditor'
import { ColorPicker, LabelPicker, ToolButton } from './NoteTools'

interface Draft {
  title: string
  body: string
  items: ChecklistItem[]
  checklist: boolean
  color: NoteColor | null
  pinned: boolean
  labels: string[]
}

const empty = (labels: string[]): Draft => ({
  title: '',
  body: '',
  items: [],
  checklist: false,
  color: null,
  pinned: false,
  labels,
})

/** The note a draft makes, or null when there's nothing in it. */
export function draftToNote(d: Draft): NoteInput | null {
  const body = d.checklist ? checklistText(d.items.filter((i) => i.text.trim())) : d.body.trim()
  if (!d.title.trim() && !body) return null
  return {
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    body,
    ...(d.color ? { color: d.color } : {}),
    ...(d.pinned ? { pinned: true } : {}),
    ...(d.labels.length ? { labels: d.labels } : {}),
  }
}

/**
 * "Take a note…": a line that opens into a card. Closing it (Close, Escape, a click outside)
 * saves the note when it has anything in it.
 */
export function Composer({
  open,
  onOpenChange,
  defaultLabels,
  labelSuggestions,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultLabels: string[]
  labelSuggestions: readonly string[]
  onCreate: (note: NoteInput) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => empty(defaultLabels))
  const [startChecklist, setStartChecklist] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const labelsKey = defaultLabels.join('\n')

  const close = useRef(() => {})
  close.current = () => {
    const note = draftToNote(draftRef.current)
    if (note) onCreate(note)
    setDraft(empty(labelsKey ? labelsKey.split('\n') : []))
    setStartChecklist(false)
    onOpenChange(false)
  }

  useEffect(() => {
    setDraft((d) => (draftToNote(d) ? d : empty(labelsKey ? labelsKey.split('\n') : [])))
  }, [labelsKey])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      // A popover's portal or the composer itself keeps it open.
      if (root.current?.contains(target)) return
      close.current()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }))

  if (!open) {
    return (
      <div className="note-surface mx-auto flex max-w-xl items-center rounded-xl border shadow-sm">
        <button
          type="button"
          data-testid="notes-take-note"
          onClick={() => onOpenChange(true)}
          className="h-12 min-w-0 flex-1 px-4 text-left text-[0.95rem] text-ink-faint"
        >
          Take a note…
        </button>
        <ToolButton
          icon="checklist"
          label="New list"
          testId="notes-new-list"
          onClick={() => {
            set({ checklist: true })
            setStartChecklist(true)
            onOpenChange(true)
          }}
        />
        <span className="w-2" />
      </div>
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the card closes it
    <div
      ref={root}
      data-testid="notes-composer"
      {...(draft.color ? { 'data-color': draft.color } : {})}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close.current()
        }
      }}
      className="note-surface mx-auto max-w-xl rounded-xl border shadow-float"
    >
      <div className="flex items-start gap-1 px-4 pt-3">
        <input
          value={draft.title}
          placeholder="Title"
          aria-label="Title"
          data-testid="composer-title"
          onChange={(e) => set({ title: e.target.value })}
          className="min-w-0 flex-1 bg-transparent py-1 font-medium text-ink outline-none placeholder:text-ink-faint"
        />
        <ToolButton
          icon="pin"
          label={draft.pinned ? 'Unpin' : 'Pin'}
          active={draft.pinned}
          onClick={() => set({ pinned: !draft.pinned })}
        />
      </div>
      <div className="px-4 pb-2">
        {draft.checklist ? (
          <ChecklistEditor
            items={draft.items}
            autoFocus={startChecklist}
            onChange={(items) => set({ items })}
          />
        ) : (
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the composer opens to type into
            autoFocus
            value={draft.body}
            placeholder="Take a note…"
            aria-label="Note"
            data-testid="composer-body"
            rows={Math.min(14, Math.max(2, draft.body.split('\n').length + 1))}
            onChange={(e) => set({ body: e.target.value })}
            className="w-full resize-none bg-transparent py-1 text-[0.95rem] text-ink outline-none placeholder:text-ink-faint"
          />
        )}
        {draft.labels.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {draft.labels.map((l) => (
              <li key={l} className="rounded-full bg-ink/10 px-2 py-0.5 text-xs text-ink">
                {l}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 px-2 pb-2">
        <ColorPicker value={draft.color} onChange={(color) => set({ color })} below />
        <LabelPicker
          value={draft.labels}
          suggestions={labelSuggestions}
          onChange={(labels) => set({ labels })}
          below
        />
        <ToolButton
          icon={draft.checklist ? 'notes' : 'checklist'}
          label={draft.checklist ? 'Hide checkboxes' : 'Show checkboxes'}
          testId="composer-toggle-list"
          onClick={() =>
            draft.checklist
              ? set({ checklist: false, body: checklistToText(draft.items) })
              : set({ checklist: true, items: textToChecklist(draft.body) })
          }
        />
        <button
          type="button"
          data-testid="composer-close"
          onClick={() => close.current()}
          className="ml-auto rounded-md px-4 py-1.5 text-sm font-medium text-ink hover:bg-ink/10"
        >
          Close
        </button>
      </div>
    </div>
  )
}
