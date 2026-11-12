import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type FormSummary, formsApi } from '../../api/forms'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'

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
  const { spaces, spaceLabel } = useSession()
  const navigate = useNavigate()
  const [forms, setForms] = useState<FormSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [space, setSpace] = useState('team')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = `Forms · ${product()}`
    formsApi.list().then(
      (r) => setForms(r.forms),
      (e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t load forms'),
    )
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const form = await formsApi.create(space, title.trim() || 'Untitled form')
      navigate(`/forms/${encodeURIComponent(form.space)}/${form.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t make the form')
      setBusy(false)
    }
  }

  return (
    <>
      <MeetingsPageHeader title="Forms" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Surveys, sign-ups and requests whose answers land in {product()}. Share a form with the
            team, or with anyone who has the link.
          </p>
          <form
            className="mb-6 flex flex-col gap-2 rounded-xl border border-ash bg-paper-raised p-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input
              aria-label="New form's title"
              placeholder="New form title, like “Equipment request”"
              className={inputClass}
              value={title}
              maxLength={200}
              data-testid="new-form-title"
              onChange={(e) => setTitle(e.target.value)}
            />
            {spaces.length > 1 ? (
              <select
                aria-label="Space"
                className={`${inputClass} sm:w-44`}
                value={space}
                data-testid="new-form-space"
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
              data-testid="new-form"
            >
              <Icon name="plus" />
              New form
            </button>
          </form>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {forms && forms.length === 0 ? (
            <p className="text-sm text-ink-faint" data-testid="forms-empty">
              No forms yet.
            </p>
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
