import type { Column } from '@hearth/format'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { tablesApi } from '../../api/tables'
import { product } from '../../brand/product'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { Grid } from './Grid'
import { loadEngine, Sheet } from './sheet'

/**
 * `/tables/form/:space/:id`: a form's answers as a live, read-only table (ARCHITECTURE §22.6).
 * "Copy to a new table" makes an editable copy in the same space.
 */
/** A fresh editor per table: switching tables never reuses one's state or engine. */
export default function FormTablePageRoute() {
  const { space = '', id = '' } = useParams()
  return <FormTablePage key={`${space}/${id}`} />
}

function FormTablePage() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<{ title: string; columns: Column[]; sheet: Sheet } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    let made: Sheet | null = null
    Promise.all([tablesApi.formTable(space, id), loadEngine()]).then(
      ([t]) => {
        if (!live) return
        made = new Sheet(t.cells)
        setData({ title: t.title, columns: t.columns, sheet: made })
        document.title = `${t.title} answers · Tables · ${product()}`
      },
      (e: unknown) =>
        live && setError(e instanceof Error ? e.message : 'Couldn’t open the answers'),
    )
    return () => {
      live = false
      made?.dispose()
    }
  }, [space, id])

  const formUrl = `/forms/${encodeURIComponent(space)}/${id}/answers`
  return (
    <>
      <MeetingsPageHeader menu={false} title={data ? `${data.title}: answers` : 'Form answers'}>
        <Link to={formUrl} className={`${secondaryButton} h-8 px-3`}>
          Open the form
        </Link>
        <button
          type="button"
          className={`${primaryButton} h-8 px-3`}
          disabled={!data || busy}
          data-testid="copy-to-table"
          onClick={async () => {
            setBusy(true)
            try {
              const t = await tablesApi.fromForm(space, { space, id })
              navigate(`/tables/${encodeURIComponent(t.space)}/${t.id}`)
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Couldn’t copy the answers')
              setBusy(false)
            }
          }}
        >
          Copy to a new table
        </button>
      </MeetingsPageHeader>
      {error ? (
        <p role="alert" className="m-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          <p className="border-b border-ash/70 bg-paper px-4 py-1.5 text-xs text-ink-faint">
            Always up to date with the form’s answers, newest first. Sort and filter from a column’s
            letter; to edit, copy it to a new table.
          </p>
          <Grid sheet={data.sheet} version={0} columns={data.columns} readOnly />
        </>
      ) : error ? null : (
        <p className="m-6 text-sm text-ink-faint">Opening the answers…</p>
      )}
    </>
  )
}
