import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type TableSummary, tablesApi } from '../../api/tables'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { LoadError } from '../../components/LoadError'
import { NewInSpaceButton, PageHeader } from '../../components/PageHeader'
import { useLoad } from '../../hooks/useLoad'
import { useSession } from '../../state/session'
import { day } from '../forms/FormsPage'

/** `/tables`: every table in a space the member can open (ARCHITECTURE §22). */
export default function TablesPage() {
  const { me, spaces, spaceLabel } = useSession()
  const navigate = useNavigate()
  const list = useLoad(() => tablesApi.list().then((r) => r.tables))
  const tables: TableSummary[] | null = list.data
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `Tables · ${product()}`
  }, [])

  // Whose the imported file will be, chosen before the file picker opens.
  const importInto = useRef('team')

  const run = async (
    work: () => Promise<{ space: string; id: string }>,
    failed: string,
    fresh = false,
  ) => {
    setBusy(true)
    setError(null)
    try {
      const t = await work()
      navigate(`/tables/${encodeURIComponent(t.space)}/${t.id}`, fresh ? { state: { fresh } } : {})
    } catch (e) {
      setError(e instanceof Error ? e.message : failed)
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Tables" menu={false}>
        <NewInSpaceButton
          secondary
          spaces={spaces}
          busy={busy || !me}
          testId="import-table-button"
          onCreate={(space) => {
            importInto.current = space
            file.current?.click()
          }}
        >
          Import
        </NewInSpaceButton>
        <input
          ref={file}
          type="file"
          accept=".csv,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          data-testid="import-table"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f)
              void run(
                () => tablesApi.importFile(importInto.current, f),
                'Couldn’t import that file',
              )
          }}
        />
        <NewInSpaceButton
          spaces={spaces}
          busy={busy || !me}
          testId="new-table"
          onCreate={(space) =>
            void run(
              () => tablesApi.create(space, 'Untitled table'),
              'Couldn’t make the table',
              true,
            )
          }
        >
          New table
        </NewInSpaceButton>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Trackers and lists with spreadsheet formulas, kept in {product()} so search and your AI
            tools can read them. Import a .csv or Excel file, or start from scratch.
          </p>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {list.failed ? (
            <LoadError things="tables" onRetry={list.reload} className="mb-4" />
          ) : null}
          {!list.failed && tables && tables.length === 0 ? (
            <EmptyState icon="table" title="No tables yet" testId="tables-empty">
              Press New table, or import a file. A form’s answers can open as a table too: Forms → a
              form → Answers → Open as a table.
            </EmptyState>
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
