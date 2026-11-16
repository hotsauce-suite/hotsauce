import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type FormSummary, formsApi } from '../../api/forms'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { LoadError } from '../../components/LoadError'
import { NewInSpaceButton, PageHeader } from '../../components/PageHeader'
import { useLoad } from '../../hooks/useLoad'
import { useSession } from '../../state/session'

export const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : ''

/** `/forms`: every form in a space the member can open (ARCHITECTURE §21). */
export default function FormsPage() {
  const { me, spaces, spaceLabel } = useSession()
  const navigate = useNavigate()
  const list = useLoad(() => formsApi.list().then((r) => r.forms))
  const forms: FormSummary[] | null = list.data
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = `Forms · ${product()}`
  }, [])

  const create = async (space: string) => {
    setBusy(true)
    setError(null)
    try {
      const form = await formsApi.create(space, 'Untitled form')
      navigate(`/forms/${encodeURIComponent(form.space)}/${form.id}`, { state: { fresh: true } })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t make the form')
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Forms" menu={false}>
        <NewInSpaceButton
          spaces={spaces}
          busy={busy || !me}
          testId="new-form"
          onCreate={(space) => void create(space)}
        >
          New form
        </NewInSpaceButton>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Surveys, sign-ups and requests whose answers land in {product()}. Share a form with the
            team, or with anyone who has the link.
          </p>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {list.failed ? <LoadError things="forms" onRetry={list.reload} className="mb-4" /> : null}
          {!list.failed && forms && forms.length === 0 ? (
            <EmptyState icon="form" title="No forms yet" testId="forms-empty">
              Press New form to start. Answers land here, and can open as a table.
            </EmptyState>
          ) : null}
          <ul className="divide-y divide-ash/70" data-testid="forms-list">
            {(forms ?? []).map((f) => (
              <li key={`${f.space}/${f.id}`}>
                <Link
                  to={`/forms/${encodeURIComponent(f.space)}/${f.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-3 hover:bg-paper-sunk"
                >
                  <Icon name="form" className="size-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{f.title}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-faint">
                    <span className="rounded-full bg-paper-sunk px-2 py-0.5">
                      {f.access === 'public' ? 'Anyone with the link' : 'Team'}
                    </span>
                    {f.open ? null : (
                      <span className="rounded-full bg-paper-sunk px-2 py-0.5">Closed</span>
                    )}
                    <span data-testid="form-answer-count">
                      {f.answerCount} {f.answerCount === 1 ? 'answer' : 'answers'}
                    </span>
                    <span className="hidden sm:inline">
                      {spaceLabel(f.space)} · {day(f.updated)}
                    </span>
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
