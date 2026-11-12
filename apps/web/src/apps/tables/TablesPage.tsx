import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type TableSummary, tablesApi } from '../../api/tables'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { day } from '../forms/FormsPage'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'

/** `/tables`: every table in a space the member can open (ARCHITECTURE §22). */
export default function TablesPage() {
  const { spaces, spaceLabel } = useSession()
  const navigate = useNavigate()
  const [tables, setTables] = useState<TableSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [space, setSpace] = useState('team')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `Tables · ${product()}`
    tablesApi.list().then(
      (r) => setTables(r.tables),
      (e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t load tables'),
    )
  }, [])

  const open = (t: { space: string; id: string }) =>
    navigate(`/tables/${encodeURIComponent(t.space)}/${t.id}`)

  const run = async (work: () => Promise<{ space: string; id: string }>, failed: string) => {
    setBusy(true)
    setError(null)
    try {
      open(await work())
    } catch (e) {
      setError(e instanceof Error ? e.message : failed)
      setBusy(false)
    }
  }

  return (
    <>
      <MeetingsPageHeader title="Tables" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Trackers and lists with spreadsheet formulas, kept in {product()} so search and Claude
            can read them. Import a .csv or Excel file, or start from scratch.
          </p>
          <form
            className="mb-6 flex flex-col gap-2 rounded-xl border border-ash bg-paper-raised p-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              void run(
                () => tablesApi.create(space, title.trim() || 'Untitled table'),
                'Couldn’t make the table',
              )
            }}
          >
            <input
              aria-label="New table's name"
              placeholder="New table name, like “Vendors”"
              className={inputClass}
              value={title}
              maxLength={200}
              data-testid="new-table-title"
              onChange={(e) => setTitle(e.target.value)}
            />
            {spaces.length > 1 ? (
              <select
                aria-label="Space"
                className={`${inputClass} sm:w-44`}
                value={space}
                onChange={(e) => setSpace(e.target.value)}
              >
                {spaces.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="submit"
              className={`${primaryButton} shrink-0`}
              disabled={busy}
              data-testid="new-table"
            >
              <Icon name="plus" />
              New table
            </button>
            <button
              type="button"
              className={`${secondaryButton} shrink-0`}
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              Import
            </button>
            <input
              ref={file}
              type="file"
              accept=".csv,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              data-testid="import-table"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void run(() => tablesApi.importFile(space, f), 'Couldn’t import that file')
              }}
            />
          </form>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {tables && tables.length === 0 ? (
            <p className="text-sm text-ink-faint" data-testid="tables-empty">
              No tables yet. A form’s answers can open as a table too: Forms → a form → Answers →
              Open as a table.
            </p>
          ) : null}
          <ul className="divide-y divide-ash/70" data-testid="tables-list">
            {(tables ?? []).map((t) => (
              <li key={`${t.space}/${t.id}`}>
                <Link
                  to={`/tables/${encodeURIComponent(t.space)}/${t.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-3 hover:bg-paper-sunk"
                >
                  <Icon name="table" className="size-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.title}</span>
                  <span className="text-xs text-ink-faint">
                    {spaceLabel(t.space)} · {day(t.updated)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}
