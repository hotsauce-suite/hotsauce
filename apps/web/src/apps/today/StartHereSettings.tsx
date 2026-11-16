// Settings → Workspace → Start-here doc: the doc Getting started opens for its last step
// (docs/PLAN-getting-started.md H3).

import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type StartHereDoc, todayApi } from '../../api/today'
import { docUrl } from '../../lib/paths'

const button =
  'rounded-lg border border-ash-strong px-3 py-1.5 text-sm text-ink hover:bg-paper-sunk disabled:opacity-50'

export function OrgStartHereSection() {
  const [doc, setDoc] = useState<StartHereDoc | null | undefined>(undefined)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    todayApi.startHere().then(
      (r) => setDoc(r.doc),
      () => setDoc(null),
    )
  }, [])
  const save = async (next: string | null) => {
    setBusy(true)
    setError(null)
    try {
      setDoc((await todayApi.setStartHere(next)).doc)
      setLink('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save')
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (link.trim()) void save(link.trim())
  }
  return (
    <section data-testid="org-start-here" id="start-here" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Start-here doc
        </h2>
        <p className="mt-2 text-ink-soft">
          The Getting started tile on Today ends with “See where the team’s work lives”. Pick a doc
          in the Team space and that step opens it for every new teammate. Leave it empty and the
          step opens Docs.
        </p>
      </div>
      <p className="text-sm text-ink" data-testid="org-start-here-now">
        {doc === undefined ? null : doc ? (
          <>
            New teammates start with{' '}
            <Link
              to={docUrl('team', doc.path)}
              className="underline decoration-ash-strong underline-offset-2 hover:decoration-ink"
            >
              {doc.title}
            </Link>
            .
          </>
        ) : (
          'No doc picked. The step opens Docs.'
        )}
      </p>
      <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink-soft">
          Open the doc, copy its address from the browser, and paste it here
          <input
            type="text"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…/docs/team/…"
            data-testid="org-start-here-link"
            className="rounded-lg border border-ash-strong bg-paper-raised px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <button
          type="submit"
          className={button}
          disabled={busy || doc === undefined || link.trim() === ''}
          data-testid="org-start-here-save"
        >
          {doc ? 'Change doc' : 'Use this doc'}
        </button>
        {doc ? (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void save(null)}
            data-testid="org-start-here-clear"
          >
            Remove
          </button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}
