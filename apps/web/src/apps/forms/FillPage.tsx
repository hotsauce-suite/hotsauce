import { checkAnswers, type Question, visibleQuestions } from '@hearth/format'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import { formsApi, type FillPage as Page } from '../../api/forms'
import { useAuthState } from '../../auth/AuthContext'
import { org, product } from '../../brand/product'
import { BrandMark } from '../../components/BrandMark'
import { Icon } from '../../components/Icon'
import { DEV_TURNSTILE_TOKEN, TurnstileWidget } from '../../components/TurnstileWidget'
import { primaryButton, secondaryButton } from '../meetings/components/common'

// `/f/:link`: a form's fill page (ARCHITECTURE §21.3), outside the app shell. A team form needs a
// member signed in; a public one opens for anyone, with Cloudflare Turnstile.

type Load =
  | { status: 'loading' }
  | { status: 'ready'; page: Page }
  | { status: 'sign-in' }
  | { status: 'missing' }
  | { status: 'error'; message: string }

const PLACEHOLDER = '00000000000000000000000000'
const field =
  'mt-1.5 w-full rounded-lg border border-ash-strong bg-paper px-3 text-[15px] text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none'

export default function FillPage() {
  const { link = '' } = useParams()
  const auth = useAuthState()
  const location = useLocation()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [sent, setSent] = useState(false)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (auth.status === 'loading') return
    let live = true
    formsApi.fill(link).then(
      (page) => {
        if (!live) return
        setLoad({ status: 'ready', page })
        document.title = `${page.title} · ${product()}`
      },
      (err: unknown) => {
        if (!live) return
        if (err instanceof HearthApiError && err.status === 401) setLoad({ status: 'sign-in' })
        else if (err instanceof HearthApiError && err.status === 404) setLoad({ status: 'missing' })
        else setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Failed' })
      },
    )
    return () => {
      live = false
    }
  }, [link, auth.status])

  const page = load.status === 'ready' ? load.page : null
  return (
    <div className="min-h-full bg-paper px-4 py-6 md:py-14" data-testid="form-fill">
      <main className="mx-auto w-full max-w-2xl">
        {page && sent ? (
          <Card>
            <div data-testid="form-sent">
              <p className="flex items-center gap-2 text-sm font-medium text-moss">
                <Icon name="check" />
                Sent
              </p>
              <h1 className="mt-2 font-display text-2xl font-semibold text-ink">{page.title}</h1>
              <p className="mt-2 text-ink-soft">Thanks, your answer was sent.</p>
              <button
                type="button"
                className={`${secondaryButton} mt-5`}
                data-testid="form-again"
                onClick={() => {
                  setSent(false)
                  setRound((r) => r + 1)
                }}
              >
                Send another answer
              </button>
            </div>
          </Card>
        ) : page ? (
          <FillForm key={round} link={link} page={page} onSent={() => setSent(true)} />
        ) : load.status === 'sign-in' ? (
          <Card>
            <h1 className="font-display text-2xl font-semibold text-ink">Sign in to answer</h1>
            <p className="mt-2 text-ink-soft">
              This form is for people at {org() || product()}.{' '}
              <Link
                to="/sign-in"
                state={{ from: location.pathname }}
                className="font-medium text-ember-strong underline"
                data-testid="form-sign-in"
              >
                Sign in
              </Link>{' '}
              and it opens here.
            </p>
          </Card>
        ) : load.status === 'missing' ? (
          <Card>
            <h1 className="font-display text-2xl font-semibold text-ink">This form doesn’t open</h1>
            <p className="mt-2 text-ink-soft" data-testid="form-missing">
              It was deleted, or the address isn’t quite right. Ask whoever sent it.
            </p>
          </Card>
        ) : load.status === 'error' ? (
          <Card>
            <h1 className="font-display text-2xl font-semibold text-ink">Couldn’t open the form</h1>
            <p className="mt-2 text-ink-soft">{load.message}</p>
          </Card>
        ) : (
          <p className="mt-16 text-center text-sm text-ink-faint">Loading…</p>
        )}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-ink-faint">
          <BrandMark className="size-3.5" />
          Forms by {product()}
        </p>
      </main>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-ash bg-paper-raised p-5 shadow-sm md:p-8">
      {children}
    </div>
  )
}

function FillForm({ link, page, onSent }: { link: string; page: Page; onSent: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(
    page.robotCheck?.kind === 'dev' ? DEV_TURNSTILE_TOKEN : null,
  )
  const [widgetKey, setWidgetKey] = useState(0)
  const [busy, setBusy] = useState(false)

  const shown = useMemo(
    () => visibleQuestions(page.questions, values as never),
    [page.questions, values],
  )
  const fileCount = Object.values(files).reduce((n, list) => n + list.length, 0)

  const set = (id: string, v: unknown) => {
    setValues((cur) => ({ ...cur, [id]: v }))
    setErrors(({ [id]: _, ...rest }) => rest)
  }

  const submit = async () => {
    setError(null)
    const raw: Record<string, unknown> = { ...values }
    for (const q of page.questions) {
      if (q.type === 'file') {
        raw[q.id] = (files[q.id] ?? []).map((f) => ({
          id: PLACEHOLDER,
          name: f.name,
          size: f.size,
        }))
      }
    }
    const checked = checkAnswers(page.questions, raw)
    if (!checked.ok) {
      setErrors(checked.errors)
      setError('Some answers need another look.')
      return
    }
    if (page.robotCheck && !token) {
      setError('Finish the check below first.')
      return
    }
    const answers = Object.fromEntries(
      Object.entries(checked.answers).filter(
        ([id]) => page.questions.find((q) => q.id === id)?.type !== 'file',
      ),
    )
    const shownIds = new Set(Object.keys(checked.answers))
    const upload: Array<[string, File]> = []
    for (const [q, list] of Object.entries(files)) {
      if (shownIds.has(q)) for (const f of list) upload.push([q, f])
    }
    setBusy(true)
    try {
      await formsApi.submit(link, { answers, token: token ?? '', files: upload })
      onSent()
    } catch (err) {
      setBusy(false)
      const details = err instanceof HearthApiError ? (err.details as { errors?: unknown }) : null
      if (details && typeof details.errors === 'object' && details.errors) {
        setErrors(details.errors as Record<string, string>)
      }
      setError(err instanceof Error ? err.message : 'Couldn’t send your answer.')
      if (page.robotCheck?.kind === 'turnstile') {
        setToken(null)
        setWidgetKey((k) => k + 1)
      }
    }
  }

  const blocked = !page.open
    ? 'This form isn’t taking answers any more.'
    : !page.canTakeAnswers
      ? 'This form can’t take answers yet. Ask whoever sent it.'
      : null

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Card>
        <h1 className="font-display text-[1.75rem] leading-tight font-semibold tracking-tight text-ink">
          {page.title}
        </h1>
        {page.description ? (
          <p className="mt-3 whitespace-pre-line text-ink-soft">{page.description}</p>
        ) : null}
        {blocked ? (
          <p
            className="mt-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink"
            data-testid="form-blocked"
          >
            {blocked}
          </p>
        ) : null}
      </Card>
      {blocked
        ? null
        : shown.map((q) => (
            <Card key={q.id}>
              <QuestionField
                question={q}
                value={values[q.id]}
                files={files[q.id] ?? []}
                room={page.maxFiles - fileCount}
                maxFileBytes={page.maxFileBytes}
                error={errors[q.id]}
                onChange={(v) => set(q.id, v)}
                onFiles={(list) => {
                  setFiles((cur) => ({ ...cur, [q.id]: list }))
                  setErrors(({ [q.id]: _, ...rest }) => rest)
                }}
              />
            </Card>
          ))}
      {blocked ? null : (
        <div className="flex flex-col gap-3">
          {page.robotCheck?.kind === 'turnstile' ? (
            <TurnstileWidget
              key={widgetKey}
              widget={page.robotCheck}
              onToken={setToken}
              testId="form-turnstile"
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-ember-strong" data-testid="form-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className={`${primaryButton} self-start px-6`}
            disabled={busy}
            data-testid="form-submit"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
    </form>
  )
}

function QuestionField({
  question: q,
  value,
  files,
  room,
  maxFileBytes,
  error,
  onChange,
  onFiles,
}: {
  question: Question
  value: unknown
  files: File[]
  room: number
  maxFileBytes: number
  error: string | undefined
  onChange: (v: unknown) => void
  onFiles: (files: File[]) => void
}) {
  const id = `fq-${q.id}`
  const [tooBig, setTooBig] = useState<string | null>(null)
  const label = (
    <span className="block font-medium text-ink">
      {q.label}
      {q.required ? (
        <span className="ml-1 text-ember-strong" title="Needs an answer">
          *
        </span>
      ) : null}
    </span>
  )
  const help = q.help ? <span className="mt-1 block text-sm text-ink-faint">{q.help}</span> : null
  const err = error ? (
    <p className="mt-2 text-sm text-ember-strong" data-testid="form-field-error">
      {error}
    </p>
  ) : null
  const text = typeof value === 'string' ? value : ''

  if (q.type === 'choice' || q.type === 'multi') {
    const picked = q.type === 'multi' ? (Array.isArray(value) ? (value as string[]) : []) : [text]
    return (
      <fieldset data-testid="form-question" data-question={q.id}>
        <legend className="contents">{label}</legend>
        {help}
        <div className="mt-3 flex flex-col gap-1">
          {(q.options ?? []).map((o) => (
            <label
              key={o}
              className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-paper-sunk"
            >
              <input
                type={q.type === 'multi' ? 'checkbox' : 'radio'}
                name={id}
                value={o}
                checked={picked.includes(o)}
                className="size-4 accent-[var(--ember)]"
                onChange={(e) => {
                  if (q.type === 'choice') onChange(o)
                  else
                    onChange(
                      e.target.checked
                        ? (q.options ?? []).filter((x) => x === o || picked.includes(x))
                        : picked.filter((x) => x !== o),
                    )
                }}
              />
              <span className="text-[15px] text-ink">{o}</span>
            </label>
          ))}
        </div>
        {q.type === 'choice' && text && !q.required ? (
          <button
            type="button"
            className="mt-1 text-sm text-ink-faint hover:text-ink"
            onClick={() => onChange('')}
          >
            Clear
          </button>
        ) : null}
        {err}
      </fieldset>
    )
  }

  if (q.type === 'rating') {
    const top = q.scale ?? 5
    return (
      <fieldset data-testid="form-question" data-question={q.id}>
        <legend className="contents">{label}</legend>
        {help}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Array.from({ length: top }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={value === n}
              className={`size-10 rounded-lg border text-sm font-medium ${
                value === n
                  ? 'border-ember bg-ember text-paper-raised'
                  : 'border-ash-strong text-ink hover:border-ember'
              }`}
              onClick={() => onChange(value === n ? undefined : n)}
            >
              {n}
            </button>
          ))}
        </div>
        {err}
      </fieldset>
    )
  }

  if (q.type === 'file') {
    return (
      <div data-testid="form-question" data-question={q.id}>
        <label htmlFor={id}>{label}</label>
        {help}
        <ul className="mt-2 flex flex-col gap-1">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}-${f.lastModified}`}
              className="flex items-center gap-2 rounded-lg bg-paper-sunk px-3 py-2 text-sm"
            >
              <Icon name="paperclip" className="size-4 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                aria-label={`Remove ${f.name}`}
                onClick={() => onFiles(files.filter((_, j) => j !== i))}
              >
                <Icon name="close" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {room > 0 ? (
          <label className={`${secondaryButton} mt-2 cursor-pointer`}>
            <Icon name="upload" />
            Add a file
            <input
              id={id}
              type="file"
              multiple
              className="sr-only"
              data-testid="form-file-input"
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])]
                e.target.value = ''
                const big = picked.find((f) => f.size > maxFileBytes)
                setTooBig(big ? `${big.name} is over 10 MB.` : null)
                onFiles(
                  [...files, ...picked.filter((f) => f.size <= maxFileBytes)].slice(
                    0,
                    files.length + room,
                  ),
                )
              }}
            />
          </label>
        ) : null}
        <p className="mt-1.5 text-xs text-ink-faint">Up to 3 files in all, 10 MB each.</p>
        {tooBig ? <p className="mt-1 text-sm text-ember-strong">{tooBig}</p> : null}
        {err}
      </div>
    )
  }

  return (
    <div data-testid="form-question" data-question={q.id}>
      <label htmlFor={id}>{label}</label>
      {help}
      {q.type === 'long' ? (
        <textarea
          id={id}
          rows={4}
          maxLength={10_000}
          className={`${field} py-2`}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : q.type === 'dropdown' ? (
        <select
          id={id}
          className={`${field} h-11`}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {(q.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={q.type === 'email' ? 'email' : q.type === 'date' ? 'date' : 'text'}
          autoComplete={q.type === 'email' ? 'email' : 'off'}
          maxLength={q.type === 'date' ? undefined : 500}
          className={`${field} h-11`}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {err}
    </div>
  )
}
