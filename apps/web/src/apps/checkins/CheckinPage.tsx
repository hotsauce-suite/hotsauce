import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  type CheckinAnswer,
  type CheckinInput,
  type CheckinView,
  checkinsApi,
} from '../../api/checkins'
import { HearthApiError } from '../../api/client'
import { hearthSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { DictateButton } from '../../components/DictateButton'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { CheckinForm } from './CheckinForm'
import { roundLabel, whenLabel } from './format'

const message = (e: unknown, fallback: string) =>
  e instanceof HearthApiError || e instanceof Error ? e.message : fallback

/** `/checkins/:id`: answer this round, and read everyone's answers, newest round first. */
export default function CheckinPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [view, setView] = useState<CheckinView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)

  const asked = useRef(0)
  const load = useCallback(async () => {
    const ask = ++asked.current
    try {
      const next = await checkinsApi.get(id)
      // A slower answer for another check-in, or an older one, is dropped.
      if (ask === asked.current) setView(next)
    } catch (e) {
      if (ask === asked.current) setError(message(e, 'Couldn’t load this check-in'))
    }
  }, [id])

  useEffect(() => {
    setView((v) => (v && v.id !== id ? null : v))
    setError(null)
  }, [id])

  useEffect(() => {
    void load()
    const off = hearthSocket.onChanged(() => void load())
    return off
  }, [load])

  useEffect(() => {
    if (view) document.title = `${view.title} · ${product()}`
  }, [view])

  // A link to a round (from the chat summary or search) scrolls to it.
  const wanted = params.get('date')
  useEffect(() => {
    if (wanted && view) document.getElementById(`round-${wanted}`)?.scrollIntoView()
  }, [wanted, view])

  const save = async (input: CheckinInput) => {
    if (!view) return
    setBusy(true)
    try {
      setView(await checkinsApi.save(view.id, { ...input, blobOid: view.blobOid }))
      setSettings(false)
    } catch (e) {
      setError(message(e, 'Couldn’t save'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!view || !window.confirm('Delete this check-in and all its answers?')) return
    try {
      await checkinsApi.remove(view.id)
      navigate('/checkins')
    } catch (e) {
      setError(message(e, 'Couldn’t delete'))
    }
  }

  const current = view?.current ?? null
  const mine = current
    ? (view?.rounds.find((r) => r.date === current.date)?.answers.find((a) => a.mine) ?? null)
    : null

  return (
    <>
      <MeetingsPageHeader title="Check-ins" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <Link
            to="/checkins"
            className="mb-3 inline-flex items-center gap-1 text-sm text-ink-soft"
          >
            <Icon name="back" className="size-3.5" />
            All check-ins
          </Link>
          {error ? (
            <p role="alert" className="mb-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {view ? (
            <>
              <div className="mb-6 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="font-display text-2xl text-ink" data-testid="checkin-title">
                    {view.title}
                  </h1>
                  <p className="mt-1 text-sm text-ink-soft">
                    {view.schedule}, in each person’s time zone
                    {view.paused ? ' · Paused' : ''} · asks {view.asked.length}{' '}
                    {view.asked.length === 1 ? 'person' : 'people'}
                  </p>
                </div>
                {view.canManage ? (
                  <button
                    type="button"
                    className={secondaryButton}
                    data-testid="checkin-settings"
                    onClick={() => setSettings(true)}
                  >
                    <Icon name="gear" />
                    Settings
                  </button>
                ) : null}
              </div>
              {current && !view.paused ? (
                <AnswerBox
                  key={`${current.date}-${mine?.id ?? 'new'}`}
                  checkinId={view.id}
                  date={current.date}
                  existing={mine}
                  onSaved={() => void load()}
                />
              ) : !current ? (
                <p className="mb-6 rounded-xl border border-ash bg-paper-raised px-4 py-3 text-sm text-ink-soft">
                  The first question goes out {view.schedule.toLowerCase()}.
                </p>
              ) : null}
              <div className="flex flex-col gap-8" data-testid="checkin-rounds">
                {view.rounds.map((round) => (
                  <section
                    key={round.date}
                    id={`round-${round.date}`}
                    data-testid="checkin-round"
                    aria-label={roundLabel(round.date)}
                  >
                    <h2 className="mb-3 text-sm font-medium tracking-wide text-ink-faint uppercase">
                      {roundLabel(round.date)}
                    </h2>
                    {round.summary ? (
                      <div
                        className="mb-3 rounded-xl border border-ash bg-paper-sunk px-4 py-3 text-sm whitespace-pre-wrap text-ink-soft"
                        data-testid="checkin-summary"
                      >
                        <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-faint">
                          <Icon name="sparkle" className="size-3" />
                          Summary{round.summary.posted ? ', posted to chat' : ''}
                        </span>
                        {round.summary.text.replace(/\*/g, '')}
                      </div>
                    ) : null}
                    {round.answers.length === 0 ? (
                      <p className="text-sm text-ink-faint">No answers yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {round.answers.map((a) => (
                          <AnswerCard
                            key={a.id}
                            checkinId={view.id}
                            answer={a}
                            onChanged={() => void load()}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
      {settings && view ? (
        <Dialog
          title="Check-in settings"
          onClose={() => setSettings(false)}
          testId="checkin-dialog"
          wide
        >
          <CheckinForm
            initial={{
              title: view.title,
              days: view.days,
              time: view.time,
              room: view.room,
              skip: view.skip,
              paused: view.paused,
            }}
            people={[...view.asked]}
            submitLabel="Save"
            busy={busy}
            onSubmit={(input) => void save(input)}
            onCancel={() => setSettings(false)}
            extra={
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
                data-testid="checkin-delete"
                onClick={() => void remove()}
              >
                <Icon name="trash" className="size-3.5" />
                Delete
              </button>
            }
          />
        </Dialog>
      ) : null}
    </>
  )
}

function AnswerBox({
  checkinId,
  date,
  existing,
  onSaved,
}: {
  checkinId: string
  date: string
  existing: CheckinAnswer | null
  onSaved: () => void
}) {
  const [text, setText] = useState(existing?.text ?? '')
  const [editing, setEditing] = useState(existing === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  if (!editing && existing) {
    return (
      <div className="mb-8 flex items-center gap-3 rounded-xl border border-ash bg-paper-raised px-4 py-3 text-sm">
        <Icon name="check" className="size-4 text-ember-strong" />
        <span className="flex-1 text-ink-soft">You’ve answered for {roundLabel(date)}.</span>
        <button
          type="button"
          className="text-ember-strong underline"
          data-testid="checkin-edit-answer"
          onClick={() => setEditing(true)}
        >
          Edit your answer
        </button>
      </div>
    )
  }

  const submit = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await checkinsApi.answer(checkinId, text, date)
      setEditing(false)
      onSaved()
    } catch (e) {
      setError(message(e, 'Couldn’t save your answer'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="mb-8 flex flex-col gap-2 rounded-xl border border-ash bg-paper-raised p-3"
      data-testid="checkin-answer-box"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="checkin-answer" className="text-sm font-medium text-ink">
        Your answer for {roundLabel(date)}
      </label>
      <textarea
        id="checkin-answer"
        ref={box}
        className={`${inputClass} min-h-28`}
        value={text}
        maxLength={10_000}
        placeholder="Type, or press Dictate and say it"
        data-testid="checkin-answer"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <DictateButton
          testId="checkin-dictate"
          onText={(words) => {
            setText((t) => (t.trim() ? `${t.trimEnd()} ${words}` : words))
            box.current?.focus()
          }}
          onError={setError}
        />
        <span className="flex-1" />
        {existing ? (
          <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || !text.trim()}
          data-testid="checkin-submit"
        >
          {existing ? 'Save' : 'Post answer'}
        </button>
      </div>
    </form>
  )
}

function AnswerCard({
  checkinId,
  answer,
  onChanged,
}: {
  checkinId: string
  answer: CheckinAnswer
  onChanged: () => void
}) {
  const [reply, setReply] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await checkinsApi.reply(checkinId, answer.id, reply)
      setReply('')
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(message(e, 'Couldn’t send the reply'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className="rounded-xl border border-ash bg-paper-raised px-4 py-3"
      data-testid="checkin-answer-card"
    >
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-medium text-ink">{answer.mine ? 'You' : answer.name}</span>
        <span className="text-xs text-ink-faint">
          {whenLabel(answer.submitted)}
          {answer.edited ? ' · edited' : ''}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap text-ink" data-testid="checkin-answer-text">
        {answer.text}
      </p>
      {answer.replies.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 border-l-2 border-ash pl-3">
          {answer.replies.map((r) => (
            <li key={r.id} className="text-sm" data-testid="checkin-reply">
              <span className="font-medium text-ink">{r.name}</span>{' '}
              <span className="text-xs text-ink-faint">{whenLabel(r.at)}</span>
              <p className="whitespace-pre-wrap text-ink-soft">{r.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <input
            className={inputClass}
            value={reply}
            maxLength={2_000}
            placeholder={`Reply to ${answer.mine ? 'yourself' : answer.name}`}
            aria-label="Reply"
            data-testid="checkin-reply-input"
            // biome-ignore lint/a11y/noAutofocus: the member just pressed Reply
            autoFocus
            onChange={(e) => setReply(e.target.value)}
          />
          <button
            type="submit"
            className={`${primaryButton} shrink-0`}
            disabled={busy || !reply.trim()}
            data-testid="checkin-reply-send"
          >
            Reply
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="mt-2 text-xs text-ink-soft hover:text-ink"
          data-testid="checkin-reply-open"
          onClick={() => setOpen(true)}
        >
          Reply
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </li>
  )
}
