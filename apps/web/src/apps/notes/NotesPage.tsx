import { toggleChecklistItem } from '@hearth/format'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useMatches, useNavigate, useParams } from 'react-router'
import { type NoteColor, type NoteInput, type NoteView, noteKey, notesApi } from '../../api/notes'
import { memberTimeZone, tasksApi } from '../../api/tasks'
import { product } from '../../brand/product'
import { useShell } from '../../components/AppShell'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { useShortcut } from '../../keyboard/shortcuts'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { Composer } from './Composer'
import { columnsFor, dealColumns, itemUrl, splitPinned } from './logic'
import type { CardActions } from './NoteCard'
import { NoteCard } from './NoteCard'
import { NoteEditor } from './NoteEditor'
import type { NotesRouteKind } from './routes'
import { errorMessage, type NotesQuery, notesBus, useNoteLabels, useNoteList } from './useNotes'

const changed = () => notesBus.emit({ type: 'changed' })

const EMPTY: Record<NotesQuery['view'], string> = {
  board: 'Notes you add appear here.',
  archive: 'Archived notes appear here.',
  trash: 'No notes in the trash. Deleted notes stay here for 30 days.',
}

function useKind(): NotesRouteKind {
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle as { notesKind?: NotesRouteKind } | undefined
    if (handle?.notesKind) return handle.notesKind
  }
  return 'board'
}

interface Toast {
  message: string
  undo?: () => void
  link?: { to: string; label: string }
}

/** Hearth Notes: the board, a label, the archive or the trash, with a note open on top. */
export default function NotesPage() {
  const kind = useKind()
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { compact } = useShell()
  const session = useSession()
  const label = kind === 'label' ? (params.label ?? '') : undefined
  const [q, setQ] = useState('')
  // An open note stays on the view it was opened from; a link straight to one shows the board.
  const from = useRef<string>('/notes')
  const view = kind === 'archive' ? 'archive' : kind === 'trash' ? 'trash' : 'board'
  if (kind !== 'item') from.current = location.pathname
  const listQuery: NotesQuery =
    kind === 'item' ? queryFor(from.current, q) : { view, label, q: q || undefined }
  const list = useNoteList(listQuery)
  const labels = useNoteLabels()
  const labelNames = useMemo(() => labels.map((l) => l.name), [labels])
  const teamSpace = session.spaces.find((s) => s.kind === 'team')?.name ?? null

  const [composerOpen, setComposerOpen] = useState(
    () => (location.state as { newNote?: boolean } | null)?.newNote === true,
  )
  const [toast, setToast] = useState<Toast | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<NoteView | null>(null)

  useEffect(() => notesBus.on((e) => e.type === 'new-note' && setComposerOpen(true)), [])
  useShortcut('global.create', () => {
    setComposerOpen(true)
    return true
  })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // The open note: from the list when it's there, else fetched.
  const openSpace = kind === 'item' ? (params.space ?? '') : null
  const openNoteId = kind === 'item' ? (params.id ?? '') : null
  const [openNote, setOpenNote] = useState<NoteView | null>(null)
  const [missing, setMissing] = useState(false)
  const notesNow = useRef(list.notes)
  notesNow.current = list.notes
  useEffect(() => {
    setMissing(false)
    if (openSpace === null || openNoteId === null) {
      setOpenNote(null)
      return
    }
    const key = noteKey({ space: openSpace, id: openNoteId })
    const known = notesNow.current?.find((n) => noteKey(n) === key)
    if (known) {
      setOpenNote((cur) => (cur && noteKey(cur) === key ? cur : known))
      return
    }
    let live = true
    notesApi.get(openSpace, openNoteId).then(
      (n) => live && setOpenNote(n),
      () => live && setMissing(true),
    )
    return () => {
      live = false
    }
  }, [openSpace, openNoteId])

  const notify = useCallback((err: unknown) => setToast({ message: errorMessage(err) }), [])

  // Card saves run one at a time per note, each guarded by the version the one before it wrote,
  // so two quick ticks aren't a conflict with yourself.
  const queues = useRef(new Map<string, { chain: Promise<unknown>; blobOid: string }>())
  const save = useCallback(
    (note: NoteView, patch: NoteInput & { baseBlobOid?: string }, optimistic?: NoteView) => {
      if (optimistic) list.replace(optimistic)
      const key = noteKey(note)
      const q = queues.current.get(key) ?? { chain: Promise.resolve(), blobOid: note.blobOid }
      queues.current.set(key, q)
      const run = q.chain.then(async () => {
        try {
          const next = await notesApi.update(
            note.space,
            note.id,
            patch.baseBlobOid === undefined ? patch : { ...patch, baseBlobOid: q.blobOid },
          )
          q.blobOid = next.blobOid
          list.replace(next)
          changed()
          return next
        } catch (err) {
          queues.current.delete(key)
          list.reload()
          notify(err)
          return null
        }
      })
      q.chain = run
      // Once idle, the next save starts again from the note as the board has it.
      void run.then(() => {
        if (queues.current.get(key)?.chain === run) queues.current.delete(key)
      })
      return run
    },
    [list, notify],
  )

  const leaves = useCallback(
    async (note: NoteView, action: () => Promise<unknown>, message: string, undo?: () => void) => {
      list.drop(note)
      try {
        await action()
        changed()
        setToast({ message, ...(undo ? { undo } : {}) })
      } catch (err) {
        list.reload()
        notify(err)
      }
    },
    [list, notify],
  )

  const actions: CardActions = {
    open: (note) => navigate(itemUrl(note)),
    tick: (note, index, checked) => {
      const body = toggleChecklistItem(note.body, index, checked)
      void save(note, { body, baseBlobOid: note.blobOid }, { ...note, body })
    },
    pin: (note) => void save(note, { pinned: !note.pinned }, { ...note, pinned: !note.pinned }),
    color: (note, color: NoteColor | null) => void save(note, { color }, { ...note, color }),
    archive: (note) =>
      void leaves(
        note,
        () => notesApi.update(note.space, note.id, { archived: !note.archived }),
        note.archived ? 'Note unarchived' : 'Note archived',
        () =>
          void notesApi
            .update(note.space, note.id, { archived: note.archived })
            .then(changed, notify),
      ),
    trash: (note) =>
      void leaves(
        note,
        () => notesApi.trash(note.space, note.id),
        'Note moved to the trash',
        () => void notesApi.restore(note.space, note.id).then(changed, notify),
      ),
    restore: (note) =>
      void leaves(note, () => notesApi.restore(note.space, note.id), 'Note restored'),
    deleteForever: (note) => setConfirmDelete(note),
  }

  const create = async (input: NoteInput) => {
    try {
      const note = await notesApi.create(input)
      list.replace(note)
      changed()
    } catch (err) {
      notify(err)
    }
  }

  const closeEditor = () => navigate(from.current === location.pathname ? '/notes' : from.current)

  const makeTask = async (note: NoteView, text: string) => {
    try {
      const task = await tasksApi.create({
        title: text,
        space: note.space,
        tz: memberTimeZone(),
      })
      setToast({
        message: `Added “${text}” to Tasks`,
        link: { to: `/tasks/item/${encodeURIComponent(task.space)}/${task.id}`, label: 'Open' },
      })
    } catch (err) {
      notify(err)
    }
  }

  const notes = list.notes
  const { pinned, others } = useMemo(() => splitPinned(notes ?? []), [notes])
  const listView = listQuery.view
  const title =
    kind === 'label'
      ? label
      : listView === 'archive'
        ? 'Archive'
        : listView === 'trash'
          ? 'Trash'
          : 'Notes'

  return (
    <>
      <MeetingsPageHeader title={`${product()} Notes`}>
        <label className="relative flex min-w-0 items-center">
          <span className="sr-only">Search notes</span>
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 size-4 text-ink-faint"
          />
          <input
            type="search"
            value={q}
            placeholder="Search"
            data-testid="notes-search"
            onChange={(e) => setQ(e.target.value)}
            className="h-9 w-36 rounded-lg border border-ash bg-paper-raised pr-2 pl-8 text-sm text-ink outline-none focus:border-ember sm:w-56"
          />
        </label>
      </MeetingsPageHeader>
      <div data-testid="notes-page" data-view={listView} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-3 pt-5 pb-28 md:px-8 md:pt-8">
          <div className="mb-4 flex items-baseline gap-3 px-1">
            <h1
              data-testid="notes-title"
              className="min-w-0 truncate font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink"
            >
              {title}
            </h1>
            {listView === 'trash' && notes && notes.length > 0 ? (
              <span className="text-sm text-ink-faint">Notes here are deleted after 30 days</span>
            ) : null}
          </div>

          {listView === 'board' && !q ? (
            <div className="mb-7">
              <Composer
                open={composerOpen}
                onOpenChange={setComposerOpen}
                defaultLabels={label ? [label] : []}
                labelSuggestions={labelNames}
                onCreate={(n) => void create(n)}
              />
            </div>
          ) : null}

          {list.error && notes?.length === 0 ? (
            <p role="alert" className="mb-4 text-sm text-ember-strong">
              {list.error}
            </p>
          ) : null}

          {notes === null ? (
            <div aria-hidden="true" data-testid="notes-loading" className="notes-board">
              {[0, 1, 2].map((n) => (
                <div key={n} className="notes-col">
                  <div className="h-28 rounded-xl bg-paper-sunk/60" />
                </div>
              ))}
            </div>
          ) : notes.length === 0 ? (
            <p
              data-testid="notes-empty"
              className="px-1 py-10 text-center text-[0.95rem] text-ink-soft"
            >
              {q ? 'No notes match that search.' : EMPTY[listView]}
            </p>
          ) : (
            <div className="space-y-6">
              {pinned.length > 0 && listView !== 'trash' ? (
                <Section title="Pinned" notes={pinned} teamSpace={teamSpace} actions={actions} />
              ) : null}
              <Section
                title={pinned.length > 0 && listView !== 'trash' ? 'Others' : ''}
                notes={listView === 'trash' ? notes : others}
                teamSpace={teamSpace}
                actions={actions}
              />
            </div>
          )}
        </div>
      </div>

      {openNote ? (
        <NoteEditor
          key={noteKey(openNote)}
          note={openNote}
          teamSpace={teamSpace}
          labelSuggestions={labelNames}
          compact={compact}
          onSaved={(n) => {
            list.replace(n)
            changed()
          }}
          onArchive={(n) => {
            closeEditor()
            actions.archive(n)
          }}
          onTrash={(n) => {
            closeEditor()
            actions.trash(n)
          }}
          onMoved={(n) => {
            list.drop(openNote)
            list.replace(n)
            changed()
            setToast({ message: 'Moved to Team: everyone can see it now' })
            navigate(itemUrl(n), { replace: true })
          }}
          onMakeTask={(n, t) => void makeTask(n, t)}
          onClose={closeEditor}
        />
      ) : null}

      {missing ? (
        <Dialog title="That note isn’t here any more" onClose={() => navigate('/notes')}>
          <p className="text-sm text-ink-soft">It may have been deleted or moved.</p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              className={`${primaryButton} h-9`}
              onClick={() => navigate('/notes')}
            >
              Back to notes
            </button>
          </div>
        </Dialog>
      ) : null}

      {confirmDelete ? (
        <Dialog
          title="Delete this note forever?"
          onClose={() => setConfirmDelete(null)}
          testId="note-delete-dialog"
        >
          <p className="text-sm text-ink-soft">
            It leaves the trash for good. Its history stays in Git.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="note-delete-confirm"
              className={`${primaryButton} h-9`}
              onClick={() => {
                const n = confirmDelete
                setConfirmDelete(null)
                void leaves(n, () => notesApi.remove(n.space, n.id), 'Note deleted forever')
              }}
            >
              Delete forever
            </button>
          </div>
        </Dialog>
      ) : null}

      {toast ? (
        <div
          role="status"
          data-testid="notes-toast"
          className={`fixed left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-lg border border-ash bg-paper-raised px-4 py-2.5 text-sm text-ink shadow-float ${compact ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'bottom-6'}`}
        >
          <span className="min-w-0">{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              data-testid="notes-undo"
              className="font-medium text-ember-strong hover:underline"
              onClick={() => {
                toast.undo?.()
                setToast(null)
              }}
            >
              Undo
            </button>
          ) : null}
          {toast.link ? (
            <Link to={toast.link.to} className="font-medium text-ember-strong hover:underline">
              {toast.link.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function queryFor(path: string, q: string): NotesQuery {
  const qq = q || undefined
  if (path === '/notes/archive') return { view: 'archive', q: qq }
  if (path === '/notes/trash') return { view: 'trash', q: qq }
  const m = /^\/notes\/label\/(.+)$/.exec(path)
  if (m?.[1]) return { view: 'board', label: decodeURIComponent(m[1]), q: qq }
  return { view: 'board', q: qq }
}

function Section({
  title,
  notes,
  teamSpace,
  actions,
}: {
  title: string
  notes: NoteView[]
  teamSpace: string | null
  actions: CardActions
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(1)
  const has = notes.length > 0
  useLayoutEffect(() => {
    if (!has) return
    const el = ref.current
    if (!el) return
    const measure = () => setCols(columnsFor(el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [has])
  if (!has) return null
  return (
    <section aria-label={title || 'Notes'} data-testid="notes-section">
      {title ? (
        <h2 className="mb-2 px-1 text-[0.7rem] font-semibold tracking-wide text-ink-faint uppercase">
          {title}
        </h2>
      ) : null}
      <div ref={ref} className="notes-board">
        {dealColumns(notes, cols).map((col, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
          <div key={i} className="notes-col">
            {col.map((n) => (
              <NoteCard key={noteKey(n)} note={n} team={n.space === teamSpace} actions={actions} />
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
