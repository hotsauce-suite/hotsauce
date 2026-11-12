import {
  MAX_QUESTIONS,
  newQuestionId,
  OPTION_TYPES,
  type Question,
  type QuestionType,
  questionsProblem,
} from '@hearth/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import { type ChatRoom, type FormInput, type FormView, formsApi } from '../../api/forms'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { FormAnswers } from './FormAnswers'

const TYPE_LABEL: Record<QuestionType, string> = {
  short: 'Short answer',
  long: 'Paragraph',
  email: 'Email',
  choice: 'One choice',
  multi: 'Several choices',
  dropdown: 'Dropdown',
  rating: 'Rating',
  date: 'Date',
  file: 'File upload',
}
const TYPES = Object.keys(TYPE_LABEL) as QuestionType[]
const hasOptions = (t: QuestionType) => OPTION_TYPES.includes(t)

type Tab = 'questions' | 'answers' | 'settings'

function inputOf(form: FormView): FormInput {
  return {
    title: form.title,
    description: form.description,
    questions: form.questions,
    access: form.access,
    open: form.open,
    room: form.room,
    blobOid: form.blobOid,
  }
}

/** `/forms/:space/:id` (questions), `…/answers` and `…/settings`. */
export default function FormEditor() {
  const { space = '', id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { spaceLabel } = useSession()
  const tab: Tab = location.pathname.endsWith('/answers')
    ? 'answers'
    : location.pathname.endsWith('/settings')
      ? 'settings'
      : 'questions'
  const [form, setForm] = useState<FormView | null>(null)
  const [draft, setDraft] = useState<FormInput | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [rooms, setRooms] = useState<ChatRoom[]>([])
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    let live = true
    formsApi.get(space, id).then(
      (f) => {
        if (!live) return
        setForm(f)
        setDraft(inputOf(f))
        setDirty(false)
      },
      (e: unknown) =>
        live && setLoadError(e instanceof Error ? e.message : 'Couldn’t open the form'),
    )
    formsApi.rooms().then(
      (r) => live && setRooms(r.rooms),
      () => {},
    )
    return () => {
      live = false
    }
  }, [space, id])

  useEffect(() => {
    if (form) document.title = `${form.title} · Forms · ${product()}`
  }, [form])

  const change = (patch: Partial<FormInput>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d))
    setDirty(true)
    setError(null)
  }

  const save = useCallback(async () => {
    if (!draft || saving || !dirty) return
    const problem = draft.title.trim()
      ? questionsProblem(draft.questions)
      : 'The form needs a title'
    if (problem) return setError(problem)
    const sent = draft
    setSaving(true)
    try {
      const saved = await formsApi.save(space, id, sent)
      setForm(saved)
      // Edits made while it saved stay: only the version moves on, and they stay unsaved.
      const still = draftRef.current === sent
      setDraft((d) => (d ? { ...d, blobOid: saved.blobOid } : d))
      if (still) setDirty(false)
      setError(null)
    } catch (e) {
      setError(
        e instanceof HearthApiError && e.status === 409
          ? 'Someone else changed this form. Reload the page to see their version.'
          : e instanceof Error
            ? e.message
            : 'Couldn’t save',
      )
    } finally {
      setSaving(false)
    }
  }, [draft, saving, dirty, space, id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [save, dirty])

  if (loadError) {
    return (
      <>
        <MeetingsPageHeader title="Forms" menu={false} />
        <div className="mx-auto max-w-3xl px-4 pt-8 md:px-8">
          <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
            {loadError}
          </p>
          <Link to="/forms" className="mt-4 inline-block text-sm text-ember-strong underline">
            All forms
          </Link>
        </div>
      </>
    )
  }
  if (!form || !draft) {
    return (
      <>
        <MeetingsPageHeader title="Forms" menu={false} />
        <p className="px-8 pt-8 text-sm text-ink-faint">Loading…</p>
      </>
    )
  }

  const base = `/forms/${encodeURIComponent(space)}/${id}`
  const copy = () => {
    // Started before anything else and not awaited: it can hang without the permission.
    void navigator.clipboard?.writeText(form.url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <MeetingsPageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/forms" className="text-ink-faint hover:text-ink" aria-label="All forms">
              <Icon name="back" />
            </Link>
            <span className="truncate">{form.title}</span>
          </span>
        }
        menu={false}
      >
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={copy}
          data-testid="form-copy-link"
          title={form.url}
        >
          <Icon name={copied ? 'check' : 'link'} />
          <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy link'}</span>
        </button>
        <a
          href={form.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${secondaryButton} h-8 px-3`}
          data-testid="form-open-link"
        >
          <Icon name="external" />
          <span className="hidden sm:inline">Open</span>
        </a>
        {tab === 'answers' ? null : (
          <button
            type="button"
            className={`${primaryButton} h-8 px-3`}
            disabled={!dirty || saving}
            onClick={() => void save()}
            data-testid="form-save"
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        )}
      </MeetingsPageHeader>
      <nav className="flex shrink-0 gap-1 border-b border-ash/70 px-2 md:px-6" aria-label="Form">
        {(
          [
            ['questions', 'Questions', base],
            ['answers', `Answers (${form.answerCount})`, `${base}/answers`],
            ['settings', 'Settings', `${base}/settings`],
          ] as const
        ).map(([key, label, to]) => (
          <NavLink
            key={key}
            to={to}
            end
            data-testid={`form-tab-${key}`}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm ${
              tab === key
                ? 'border-ember font-medium text-ink'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="mx-auto max-w-3xl px-4 pt-4 md:px-8">
            <p
              role="alert"
              className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink"
              data-testid="form-save-error"
            >
              {error}
            </p>
          </div>
        ) : null}
        {tab === 'answers' ? (
          <FormAnswers
            form={form}
            onCount={(n) => setForm((f) => (f ? { ...f, answerCount: n } : f))}
          />
        ) : tab === 'settings' ? (
          <Settings
            form={form}
            draft={draft}
            rooms={rooms}
            spaceLabel={spaceLabel(space)}
            onChange={change}
            onDeleted={() => navigate('/forms')}
          />
        ) : (
          <Builder draft={draft} onChange={change} />
        )}
      </div>
    </>
  )
}

function Builder({
  draft,
  onChange,
}: {
  draft: FormInput
  onChange: (p: Partial<FormInput>) => void
}) {
  const [adding, setAdding] = useState<QuestionType>('short')
  const qs = draft.questions
  // Every change keeps show-if rules pointing at a real earlier option: a renamed option takes
  // its rules along, and a rule whose option or question is gone is dropped.
  const setQuestions = (next: Question[]) => onChange({ questions: dropBrokenRules(next) })
  const update = (i: number, q: Question) => {
    const before = qs[i]
    const renames = new Map<string, string>()
    if (
      before &&
      before.id === q.id &&
      before.options &&
      q.options?.length === before.options.length
    ) {
      before.options.forEach((o, k) => {
        const now = q.options?.[k]
        if (now !== undefined && now !== o) renames.set(o, now)
      })
    }
    setQuestions(
      qs.map((x, j) => {
        if (j === i) return q
        const rule = x.show_if
        if (rule?.question === q.id && renames.has(rule.is)) {
          return { ...x, show_if: { question: rule.question, is: renames.get(rule.is) ?? rule.is } }
        }
        return x
      }),
    )
  }
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= qs.length) return
    const next = [...qs]
    const [item] = next.splice(i, 1)
    if (item) next.splice(j, 0, item)
    // A question can only depend on one before it; moving above its source drops the rule.
    setQuestions(next)
  }
  const add = () => {
    const q: Question = {
      id: newQuestionId(qs.map((x) => x.id)),
      type: adding,
      label: '',
      required: false,
      ...(hasOptions(adding) ? { options: ['Option 1', 'Option 2'] } : {}),
      ...(adding === 'rating' ? { scale: 5 as const } : {}),
    }
    setQuestions([...qs, q])
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
      <div className="flex flex-col gap-3 rounded-xl border border-ash bg-paper-raised p-4">
        <input
          aria-label="Form title"
          className="w-full bg-transparent font-display text-2xl font-semibold text-ink focus:outline-none"
          value={draft.title}
          maxLength={200}
          data-testid="form-title"
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <textarea
          aria-label="Description"
          placeholder="What this form is for (shown at the top)"
          className="w-full resize-y bg-transparent text-ink-soft placeholder:text-ink-faint focus:outline-none"
          rows={2}
          maxLength={5000}
          value={draft.description}
          data-testid="form-description"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <ol className="mt-4 flex flex-col gap-3" data-testid="form-questions">
        {qs.map((q, i) => (
          <QuestionCard
            key={q.id}
            q={q}
            index={i}
            count={qs.length}
            earlier={qs.slice(0, i).filter((x) => hasOptions(x.type))}
            onChange={(next) => update(i, next)}
            onMove={(by) => move(i, by)}
            onDuplicate={() => {
              const copy = { ...q, id: newQuestionId(qs.map((x) => x.id)) }
              setQuestions([...qs.slice(0, i + 1), copy, ...qs.slice(i + 1)])
            }}
            onDelete={() => setQuestions(qs.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      {qs.length < MAX_QUESTIONS ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            aria-label="Type of the new question"
            className={`${inputClass} w-auto`}
            value={adding}
            data-testid="add-question-type"
            onChange={(e) => setAdding(e.target.value as QuestionType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={secondaryButton}
            onClick={add}
            data-testid="add-question"
          >
            <Icon name="plus" />
            Add question
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Drops show-if rules that no longer point at an earlier question with that option. */
function dropBrokenRules(qs: Question[]): Question[] {
  return qs.map((q, i) => {
    if (!q.show_if) return q
    const rule = q.show_if
    const by = qs.slice(0, i).find((x) => x.id === rule.question)
    if (by && hasOptions(by.type) && (by.options ?? []).includes(rule.is)) return q
    const { show_if: _, ...rest } = q
    return rest
  })
}

function QuestionCard({
  q,
  index,
  count,
  earlier,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: {
  q: Question
  index: number
  count: number
  earlier: Question[]
  onChange: (q: Question) => void
  onMove: (by: number) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const setType = (type: QuestionType) => {
    const { options: _o, scale: _s, ...rest } = q
    onChange({
      ...rest,
      type,
      ...(hasOptions(type)
        ? { options: q.options?.length ? q.options : ['Option 1', 'Option 2'] }
        : {}),
      ...(type === 'rating' ? { scale: q.scale ?? 5 } : {}),
    })
  }
  const options = q.options ?? []
  const setOptions = (next: string[]) => onChange({ ...q, options: next })
  const rule = q.show_if
  const source = earlier.find((x) => x.id === rule?.question)

  return (
    <li
      className="rounded-xl border border-ash bg-paper-raised p-4"
      data-testid="question-card"
      data-question={q.id}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          aria-label={`Question ${index + 1}`}
          placeholder="Question"
          className={inputClass}
          value={q.label}
          maxLength={300}
          data-testid="question-label"
          onChange={(e) => onChange({ ...q, label: e.target.value })}
        />
        <select
          aria-label="Question type"
          className={`${inputClass} sm:w-48`}
          value={q.type}
          data-testid="question-type"
          onChange={(e) => setType(e.target.value as QuestionType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <input
        aria-label="Help text"
        placeholder="Help text (optional)"
        className={`${inputClass} mt-2 h-9 text-sm`}
        value={q.help ?? ''}
        maxLength={500}
        onChange={(e) => {
          const { help: _, ...rest } = q
          onChange(e.target.value ? { ...q, help: e.target.value } : rest)
        }}
      />
      {hasOptions(q.type) ? (
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="question-options">
          {options.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: options are edited in place, in order
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 text-center text-ink-faint">
                {q.type === 'multi' ? '☐' : '○'}
              </span>
              <input
                aria-label={`Option ${i + 1}`}
                className={`${inputClass} h-9 text-sm`}
                value={o}
                maxLength={200}
                data-testid="question-option"
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                type="button"
                aria-label={`Remove option ${i + 1}`}
                className="text-ink-faint hover:text-ink disabled:opacity-40"
                disabled={options.length <= 1}
                onClick={() => setOptions(options.filter((_, j) => j !== i))}
              >
                <Icon name="close" className="size-4" />
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="ml-7 text-sm text-ember-strong hover:underline"
              data-testid="add-option"
              onClick={() => setOptions([...options, `Option ${options.length + 1}`])}
            >
              Add option
            </button>
          </li>
        </ul>
      ) : null}
      {q.type === 'rating' ? (
        <label className="mt-3 flex items-center gap-2 text-sm whitespace-nowrap text-ink-soft">
          Scale 1 to
          <select
            className="h-9 w-20 rounded-lg border border-ash-strong bg-paper-raised px-2 text-sm text-ink focus:border-ember focus:outline-none"
            value={q.scale ?? 5}
            onChange={(e) => onChange({ ...q, scale: Number(e.target.value) === 10 ? 10 : 5 })}
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
          </select>
        </label>
      ) : null}
      {earlier.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          <span>Show</span>
          <select
            aria-label="When to show this question"
            className={`${inputClass} h-9 w-auto max-w-56 text-sm`}
            value={rule?.question ?? ''}
            data-testid="question-show-if"
            onChange={(e) => {
              const by = earlier.find((x) => x.id === e.target.value)
              const { show_if: _, ...rest } = q
              onChange(
                by ? { ...q, show_if: { question: by.id, is: by.options?.[0] ?? '' } } : rest,
              )
            }}
          >
            <option value="">always</option>
            {earlier.map((x) => (
              <option key={x.id} value={x.id}>
                when “{x.label || 'Untitled question'}”
              </option>
            ))}
          </select>
          {source && rule ? (
            <>
              <span>is</span>
              <select
                aria-label="The answer that shows it"
                className={`${inputClass} h-9 w-auto max-w-56 text-sm`}
                value={rule.is}
                data-testid="question-show-if-option"
                onChange={(e) =>
                  onChange({ ...q, show_if: { question: rule.question, is: e.target.value } })
                }
              >
                {(source.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-ash/60 pt-3">
        <label className="mr-auto flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={q.required}
            className="accent-[var(--ember)]"
            data-testid="question-required"
            onChange={(e) => onChange({ ...q, required: e.target.checked })}
          />
          Needs an answer
        </label>
        <CardButton
          icon="chevron"
          label="Move up"
          rotate="-rotate-90"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <CardButton
          icon="chevron"
          label="Move down"
          rotate="rotate-90"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        />
        <CardButton icon="copy" label="Duplicate" onClick={onDuplicate} />
        <CardButton icon="trash" label="Delete question" onClick={onDelete} />
      </div>
    </li>
  )
}

function CardButton({
  icon,
  label,
  onClick,
  disabled,
  rotate = '',
}: {
  icon: 'chevron' | 'copy' | 'trash'
  label: string
  onClick: () => void
  disabled?: boolean
  rotate?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink disabled:opacity-30"
      onClick={onClick}
    >
      <Icon name={icon} className={`size-4 ${rotate}`} />
    </button>
  )
}

function Settings({
  form,
  draft,
  rooms,
  spaceLabel,
  onChange,
  onDeleted,
}: {
  form: FormView
  draft: FormInput
  rooms: ChatRoom[]
  spaceLabel: string
  onChange: (p: Partial<FormInput>) => void
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roomGone = draft.room !== null && !rooms.some((r) => r.id === draft.room)
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6 pb-24 md:px-8">
      <section>
        <h2 className="font-display text-lg font-semibold text-ink">Who can answer</h2>
        <div className="mt-3 flex flex-col gap-2">
          {(
            [
              ['team', 'People who can sign in', 'Only your team; each answer shows who sent it.'],
              [
                'public',
                'Anyone with the link',
                'People outside the team can answer without signing in. A quick check keeps robots out.',
              ],
            ] as const
          ).map(([value, title, hint]) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-ash p-3 hover:border-ember"
            >
              <input
                type="radio"
                name="access"
                className="mt-1 accent-[var(--ember)]"
                checked={draft.access === value}
                data-testid={`form-access-${value}`}
                onChange={() => onChange({ access: value })}
              />
              <span>
                <span className="block font-medium text-ink">{title}</span>
                <span className="block text-sm text-ink-faint">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-sm text-ink-faint">
          Answers are kept in {spaceLabel}, and only people who can open {spaceLabel} see them.
        </p>
      </section>
      <section>
        <h2 className="font-display text-lg font-semibold text-ink">Taking answers</h2>
        <label className="mt-3 flex items-center gap-2 text-ink">
          <input
            type="checkbox"
            checked={draft.open}
            className="accent-[var(--ember)]"
            data-testid="form-open"
            onChange={(e) => onChange({ open: e.target.checked })}
          />
          Accepting answers
        </label>
        <p className="mt-1 text-sm text-ink-faint">
          Turn it off to close the form. The link then says it isn’t taking answers.
        </p>
      </section>
      <section>
        <h2 className="font-display text-lg font-semibold text-ink">Post new answers to chat</h2>
        {rooms.length === 0 && !draft.room ? (
          <p className="mt-2 text-sm text-ink-faint" data-testid="form-no-rooms">
            No chat rooms yet. An admin adds them in{' '}
            <Link to="/settings/organization" className="text-ember-strong underline">
              Settings → Organization
            </Link>
            .
          </p>
        ) : (
          <select
            aria-label="Chat room"
            className={`${inputClass} mt-3 w-auto min-w-56`}
            value={draft.room ?? ''}
            data-testid="form-room"
            onChange={(e) => onChange({ room: e.target.value || null })}
          >
            <option value="">Don’t post</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
            {roomGone ? <option value={draft.room ?? ''}>A removed room</option> : null}
          </select>
        )}
      </section>
      <section className="border-t border-ash/70 pt-6">
        <button
          type="button"
          className={`${secondaryButton} text-ember-strong`}
          data-testid="form-delete"
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" />
          Delete form
        </button>
        {error ? <p className="mt-2 text-sm text-ember-strong">{error}</p> : null}
      </section>
      {confirming ? (
        <Dialog
          title="Delete this form?"
          onClose={() => setConfirming(false)}
          testId="form-delete-dialog"
        >
          <p className="text-sm text-ink-soft">
            “{form.title}” and its {form.answerCount}{' '}
            {form.answerCount === 1 ? 'answer' : 'answers'} move to the space’s trash, and the link
            stops working.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              data-testid="form-delete-confirm"
              onClick={() =>
                formsApi.remove(form.space, form.id).then(onDeleted, (e: unknown) => {
                  setConfirming(false)
                  setError(e instanceof Error ? e.message : 'Couldn’t delete')
                })
              }
            >
              Delete
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
