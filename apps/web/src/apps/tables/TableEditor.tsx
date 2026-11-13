import { type Column, fitColumns, normalizeCells } from '@hearth/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import { peopleApi } from '../../api/people'
import { type TableView, tablesApi } from '../../api/tables'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { type Change, Grid, type Structure } from './Grid'
import { loadEngine, Sheet } from './sheet'

/** Saves this long after the last change. */
const SAVE_AFTER_MS = 1000
const HISTORY = 30

type Status = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict'

interface Snapshot {
  cells: string[][]
  columns: Column[]
}

export async function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const fileTitle = (title: string) => title.replace(/[^\w .-]+/g, '').trim() || 'table'

/** `/tables/:space/:id`: one table, saved as you type (ARCHITECTURE §22.8). */
/** A fresh editor per table: switching tables never reuses one's state or engine. */
export default function TableEditorRoute() {
  const { space = '', id = '' } = useParams()
  return <TableEditor key={`${space}/${id}`} />
}

function TableEditor() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { spaceLabel } = useSession()
  const [table, setTable] = useState<TableView | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [columns, setColumns] = useState<Column[]>([])
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState(0)
  const [status, setStatus] = useState<Status>('saved')
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [people, setPeople] = useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)

  // What the saver reads; refs so a save in flight sees the newest edits.
  const blobOid = useRef('')
  const latest = useRef({ title: '', columns: [] as Column[] })
  const changed = useRef(0)
  const saving = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undo = useRef<Snapshot[]>([])
  const redo = useRef<Snapshot[]>([])
  const sheetRef = useRef<Sheet | null>(null)
  sheetRef.current = sheet
  latest.current = { title, columns }

  useEffect(() => {
    let live = true
    let made: Sheet | null = null
    Promise.all([tablesApi.get(space, id), loadEngine()]).then(
      ([t]) => {
        if (!live) return
        made = new Sheet(t.cells)
        blobOid.current = t.blobOid
        setTable(t)
        setTitle(t.title)
        setColumns(t.columns)
        setSheet(made)
      },
      (e: unknown) =>
        live && setLoadError(e instanceof Error ? e.message : 'Couldn’t open the table'),
    )
    peopleApi.list().then(
      (r) => live && setPeople(r.people.filter((p) => p.team).map((p) => p.email)),
      () => {},
    )
    return () => {
      live = false
      made?.dispose()
    }
  }, [space, id])

  useEffect(() => {
    document.title = `${title || 'Table'} · Tables · ${product()}`
  }, [title])

  const save = useCallback(async () => {
    const s = sheetRef.current
    if (!s || saving.current || changed.current === 0) return
    if (timer.current) clearTimeout(timer.current)
    const sent = changed.current
    const cells = normalizeCells(s.snapshot())
    const { title: t, columns: cols } = latest.current
    saving.current = true
    setStatus('saving')
    try {
      const saved = await tablesApi.save(space, id, {
        title: t.trim() || 'Untitled table',
        columns: fitColumns(cols, cells[0]?.length ?? 1),
        cells,
        blobOid: blobOid.current,
      })
      blobOid.current = saved.blobOid
      setTable(saved)
      setError(null)
      // Edits made while it saved are still to send.
      if (changed.current === sent) {
        changed.current = 0
        setStatus('saved')
      } else {
        setStatus('unsaved')
        timer.current = setTimeout(() => void save(), SAVE_AFTER_MS)
      }
    } catch (e) {
      if (e instanceof HearthApiError && e.status === 409) {
        setStatus('conflict')
      } else {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Couldn’t save')
      }
    } finally {
      saving.current = false
    }
  }, [space, id])

  const touched = useCallback(() => {
    changed.current++
    setStatus((st) => (st === 'conflict' ? st : 'unsaved'))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), SAVE_AFTER_MS)
  }, [save])

  const remember = () => {
    const s = sheetRef.current
    if (!s) return
    undo.current.push({ cells: s.snapshot(), columns: latest.current.columns })
    if (undo.current.length > HISTORY) undo.current.shift()
    redo.current = []
  }

  const onChange = (changes: Change[]) => {
    if (!sheet || status === 'conflict') return
    remember()
    sheet.set(changes)
    setVersion((v) => v + 1)
    touched()
  }

  const onStructure = (op: Structure) => {
    if (!sheet || status === 'conflict') return
    remember()
    const next = [...columns]
    if (op.kind === 'insertRows') sheet.insertRows(op.at, op.count)
    if (op.kind === 'deleteRows') sheet.deleteRows(op.at, op.count)
    if (op.kind === 'insertColumns') {
      sheet.insertColumns(op.at, op.count)
      if (next.length > op.at)
        next.splice(
          op.at,
          0,
          ...Array.from({ length: op.count }, () => ({ type: 'text' as const })),
        )
    }
    if (op.kind === 'deleteColumns') {
      sheet.deleteColumns(op.at, op.count)
      next.splice(op.at, op.count)
    }
    setColumns(next)
    latest.current.columns = next
    setVersion((v) => v + 1)
    touched()
  }

  const onColumns = (next: Column[]) => {
    if (status === 'conflict') return
    remember()
    setColumns(next)
    latest.current.columns = next
    setVersion((v) => v + 1)
    touched()
  }

  const step = (from: typeof undo, to: typeof redo) => {
    const s = sheetRef.current
    const snap = from.current.pop()
    if (!s || !snap || status === 'conflict') return
    to.current.push({ cells: s.snapshot(), columns: latest.current.columns })
    s.restore(snap.cells)
    setColumns(snap.columns)
    latest.current.columns = snap.columns
    setVersion((v) => v + 1)
    touched()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    const onLeave = (e: BeforeUnloadEvent) => {
      if (changed.current > 0) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onLeave)
      // Leaving the page within the pause still saves what was typed.
      if (timer.current) {
        clearTimeout(timer.current)
        void save()
      }
    }
  }, [save])

  if (loadError) {
    return (
      <>
        <MeetingsPageHeader title="Tables" menu={false} />
        <p role="alert" className="m-6 text-sm text-ink">
          {loadError}
        </p>
      </>
    )
  }
  if (!table || !sheet) {
    return (
      <>
        <MeetingsPageHeader title="Tables" menu={false} />
        <p className="m-6 text-sm text-ink-faint">Opening the table…</p>
      </>
    )
  }

  const statusText: Record<Status, string> = {
    saved: 'Saved',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Not saved',
    conflict: 'Not saved',
  }

  return (
    <>
      <MeetingsPageHeader
        menu={false}
        title={
          <input
            aria-label="Table name"
            data-testid="table-title"
            className="w-full max-w-md rounded-md border border-transparent bg-transparent px-1 font-display text-lg font-semibold tracking-tight text-ink hover:border-ash focus:border-ember focus:outline-none"
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value)
              latest.current.title = e.target.value
              touched()
            }}
          />
        }
      >
        <span className="hidden text-xs text-ink-faint sm:inline">{spaceLabel(space)}</span>
        <span
          className={`text-xs ${status === 'error' || status === 'conflict' ? 'text-ember-strong' : 'text-ink-faint'}`}
          data-testid="save-status"
        >
          {statusText[status]}
        </span>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={async () => download(await tablesApi.csv(space, id), `${fileTitle(title)}.csv`)}
        >
          CSV
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          data-testid="download-xlsx"
          onClick={async () =>
            download(await tablesApi.xlsx(space, id), `${fileTitle(title)}.xlsx`)
          }
        >
          Excel
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </MeetingsPageHeader>
      {status === 'conflict' ? (
        <div
          role="alert"
          className="flex items-center gap-3 bg-ember-wash px-4 py-2 text-sm text-ink"
        >
          Someone else changed this table while you were editing. Reload to see their version; your
          last changes weren’t saved.
          <button
            type="button"
            className={`${primaryButton} h-8 px-3`}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex items-center gap-3 bg-ember-wash px-4 py-2 text-sm text-ink"
        >
          {error}
          <button
            type="button"
            className={`${secondaryButton} h-8 px-3`}
            onClick={() => void save()}
          >
            Try again
          </button>
        </div>
      ) : null}
      <Grid
        sheet={sheet}
        version={version}
        columns={columns}
        people={people}
        onChange={onChange}
        onStructure={onStructure}
        onColumns={onColumns}
        onUndo={() => step(undo, redo)}
        onRedo={() => step(redo, undo)}
      />
      {confirmDelete ? (
        <Dialog title="Delete this table?" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-ink-soft">
            “{title}” moves to the trash in {spaceLabel(space)}. Its history stays in Git.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setConfirmDelete(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className={primaryButton}
              data-testid="confirm-delete-table"
              onClick={async () => {
                if (timer.current) clearTimeout(timer.current)
                changed.current = 0
                await tablesApi.remove(space, id)
                navigate('/tables')
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}
