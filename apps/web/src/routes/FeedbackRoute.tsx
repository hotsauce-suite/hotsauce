import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { HearthApiError } from '../api/client'
import {
  type FeedbackItem,
  type FeedbackKind,
  feedbackApi,
  type QA,
  STATUS_TEXT,
} from '../api/feedback'
import {
  MeetingsPageHeader,
  primaryButton,
  secondaryButton,
} from '../apps/meetings/components/common'
import { product } from '../brand/product'
import { Icon } from '../components/Icon'

type Step =
  | { at: 'write' }
  | { at: 'questions'; questions: string[]; answers: string[] }
  | { at: 'sent'; number: number }

const MAX_TEXT = 5000

/**
 * `/feedback`: report a bug or suggest an idea (docs/plans/2026-11-12-feedback.md). The server's
 * AI may ask a follow-up question or two first; then it is filed for the team, and the member
 * follows it under "Your feedback".
 */
export default function FeedbackRoute() {
  const [params] = useSearchParams()
  const from = params.get('from') ?? undefined
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [kind, setKind] = useState<FeedbackKind>(params.get('kind') === 'idea' ? 'idea' : 'bug')
  const [text, setText] = useState('')
  const [step, setStep] = useState<Step>({ at: 'write' })
  const [qa, setQa] = useState<QA[]>([])
  const [round, setRound] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<FeedbackItem[] | null>(null)

  const load = useCallback(() => {
    feedbackApi.mine().then(
      (r) => setItems(r.items),
      () => setItems([]),
    )
  }, [])

  useEffect(() => {
    document.title = `Send feedback · ${product()}`
    feedbackApi.status().then(
      (s) => {
        setEnabled(s.enabled)
        if (s.enabled) load()
      },
      () => setEnabled(false),
    )
  }, [load])

  const file = async (answers: QA[], ready?: { title: string; summary: string }) => {
    const filed = await feedbackApi.submit({
      kind,
      text,
      answers,
      ...(ready ? { title: ready.title, summary: ready.summary } : {}),
      context: {
        ...(from ? { page: from } : {}),
        app: product(),
        browser: navigator.userAgent,
      },
    })
    setStep({ at: 'sent', number: filed.number })
    setText('')
    setQa([])
    setRound(0)
    load()
  }

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof HearthApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const ask = (answers: QA[], nextRound: number) =>
    run(async () => {
      let result: Awaited<ReturnType<typeof feedbackApi.clarify>>
      try {
        result = await feedbackApi.clarify({ kind, text, answers, round: nextRound })
      } catch (err) {
        // Past the hour's limit on questions: send what they wrote rather than nothing.
        if (err instanceof HearthApiError && err.status === 429) return file(answers)
        throw err
      }
      if (result.ready) {
        await file(answers, result)
      } else {
        setQa(answers)
        setRound(nextRound + 1)
        setStep({
          at: 'questions',
          questions: result.questions,
          answers: result.questions.map(() => ''),
        })
      }
    })

  const onSend = (event: FormEvent) => {
    event.preventDefault()
    if (text.trim() === '') return
    void ask([], 0)
  }

  const answered = (s: Extract<Step, { at: 'questions' }>): QA[] => [
    ...qa,
    ...s.questions
      .map((question, i) => ({ question, answer: s.answers[i]?.trim() ?? '' }))
      .filter((x) => x.answer !== ''),
  ]

  return (
    <>
      <MeetingsPageHeader title="Send feedback" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-6 md:pt-10">
          <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">
            Tell us what to fix or build
          </h2>
          <p className="mt-2 text-ink-soft">
            Report something broken or suggest an idea for {product()}. If it needs more detail
            we’ll ask a quick question, then the team picks it up. You can follow it below.
          </p>

          {enabled === false ? (
            <p
              data-testid="feedback-off"
              className="mt-6 rounded-xl border border-ash bg-paper-raised/60 p-4 text-sm text-ink-soft"
            >
              Feedback isn’t set up on this {product()} yet. An admin turns it on by connecting a
              GitHub repository.
            </p>
          ) : null}

          {enabled && step.at === 'write' ? (
            <form
              onSubmit={onSend}
              className="mt-6 flex flex-col gap-3"
              data-testid="feedback-form"
            >
              <fieldset className="flex gap-2">
                <legend className="sr-only">What kind of feedback</legend>
                {(
                  [
                    ['bug', 'Something’s broken'],
                    ['idea', 'I have an idea'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={`flex h-10 cursor-pointer items-center rounded-lg border px-4 text-sm ${
                      kind === value
                        ? 'border-ember bg-ember-wash text-ember-strong'
                        : 'border-ash-strong text-ink-soft hover:border-ember'
                    }`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                      className="sr-only"
                      data-testid={`feedback-kind-${value}`}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1 text-sm text-ink-soft">
                {kind === 'bug'
                  ? 'What happened, and what did you expect?'
                  : 'What would you like to do, and where?'}
                <textarea
                  data-testid="feedback-text"
                  value={text}
                  maxLength={MAX_TEXT}
                  rows={6}
                  onChange={(e) => setText(e.target.value)}
                  className="rounded-lg border border-ash-strong bg-paper-raised px-3 py-2 text-base text-ink focus:border-ember focus:outline-none"
                />
              </label>
              <p className="text-xs text-ink-faint">
                Please don’t paste passwords or keys. Anything that looks like one is removed before
                it’s sent.
              </p>
              <div>
                <button
                  type="submit"
                  data-testid="feedback-send"
                  disabled={busy || text.trim() === ''}
                  className={primaryButton}
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          ) : null}

          {enabled && step.at === 'questions' ? (
            <form
              data-testid="feedback-questions"
              className="mt-6 flex flex-col gap-4 rounded-xl border border-ash bg-paper-raised/60 p-4"
              onSubmit={(e) => {
                e.preventDefault()
                void ask(answered(step), round)
              }}
            >
              <p className="text-sm font-medium text-ink">A quick question before we send it:</p>
              {step.questions.map((q, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the model may repeat a question
                <label key={i} className="flex flex-col gap-1 text-sm text-ink-soft">
                  {q}
                  <textarea
                    data-testid="feedback-answer"
                    rows={2}
                    maxLength={2000}
                    value={step.answers[i] ?? ''}
                    onChange={(e) =>
                      setStep({
                        ...step,
                        answers: step.answers.map((a, j) => (j === i ? e.target.value : a)),
                      })
                    }
                    className="rounded-lg border border-ash-strong bg-paper-raised px-3 py-2 text-base text-ink focus:border-ember focus:outline-none"
                  />
                </label>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  data-testid="feedback-answer-send"
                  disabled={busy || step.answers.every((a) => a.trim() === '')}
                  className={primaryButton}
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
                <button
                  type="button"
                  data-testid="feedback-send-as-is"
                  disabled={busy}
                  className={secondaryButton}
                  onClick={() => void run(() => file(answered(step)))}
                >
                  Send as is
                </button>
              </div>
            </form>
          ) : null}

          {enabled && step.at === 'sent' ? (
            <div
              data-testid="feedback-sent"
              className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4"
            >
              <Icon name="check" className="size-5 text-ember" />
              <p className="min-w-0 flex-1 text-ink">Thanks, it’s with the team.</p>
              <button
                type="button"
                className={secondaryButton}
                data-testid="feedback-another"
                onClick={() => setStep({ at: 'write' })}
              >
                Send another
              </button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-3 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}

          {enabled ? <YourFeedback items={items} onChanged={load} /> : null}
        </div>
      </div>
    </>
  )
}

function YourFeedback({
  items,
  onChanged,
}: {
  items: FeedbackItem[] | null
  onChanged: () => void
}) {
  return (
    <>
      <h3 className="mt-10 text-sm font-semibold text-ink-soft">Your feedback</h3>
      {items === null ? null : items.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">Nothing sent yet.</p>
      ) : (
        <ul
          data-testid="feedback-list"
          className="mt-2 divide-y divide-ash/70 rounded-xl border border-ash"
        >
          {items.map((item) => (
            <FeedbackRow key={item.number} item={item} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </>
  )
}

function FeedbackRow({ item, onChanged }: { item: FeedbackItem; onChanged: () => void }) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = item.status === 'shipped' || item.status === 'declined'
  const send = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await feedbackApi.reply(item.number, reply)
      setReply('')
      onChanged()
    } catch (err) {
      setError(err instanceof HearthApiError ? err.message : 'Couldn’t send that. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <li data-testid="feedback-item" data-number={item.number} className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 font-medium text-ink">{item.title}</span>
        <span
          data-testid="feedback-status"
          className={`rounded-full px-2 py-0.5 text-xs ${
            item.status === 'needs info'
              ? 'bg-ember-wash text-ember-strong'
              : done
                ? 'bg-paper-sunk text-ink-faint'
                : 'bg-paper-sunk text-ink-soft'
          }`}
        >
          {STATUS_TEXT[item.status]}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">
        {item.kind === 'bug' ? 'Bug' : 'Idea'} · sent{' '}
        {new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      </p>
      {item.status === 'needs info' && item.question ? (
        <form onSubmit={(e) => void send(e)} className="mt-3 flex flex-col gap-2">
          <p
            data-testid="feedback-question"
            className="rounded-lg bg-paper-sunk px-3 py-2 whitespace-pre-wrap text-ink"
          >
            {item.question}
          </p>
          <textarea
            data-testid="feedback-reply"
            rows={2}
            maxLength={5000}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Your answer"
            className="rounded-lg border border-ash-strong bg-paper-raised px-3 py-2 text-base text-ink focus:border-ember focus:outline-none"
          />
          <div>
            <button
              type="submit"
              data-testid="feedback-reply-send"
              disabled={busy || reply.trim() === ''}
              className={primaryButton}
            >
              Answer
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  )
}
