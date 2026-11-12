import { type AnswerFile, type AnswerValue, displayValue } from '@hearth/format'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Link, useSearchParams } from 'react-router'
import { type AnswerRow, type FormView, formsApi, type Summary } from '../../api/forms'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { primaryButton, secondaryButton } from '../meetings/components/common'

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })

const isFiles = (v: AnswerValue | undefined): v is AnswerFile[] =>
  Array.isArray(v) && v.length > 0 && typeof v[0] === 'object'

/** The Answers tab: summary, table, one answer in full, CSV (ARCHITECTURE §21.4). */
export function FormAnswers({ form, onCount }: { form: FormView; onCount: (n: number) => void }) {
  const [rows, setRows] = useState<AnswerRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canSummarize, setCanSummarize] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [params, setParams] = useSearchParams()
  const open = params.get('answer')
  const countRef = useRef(onCount)
  countRef.current = onCount

  useEffect(() => {
    let live = true
    formsApi.answers(form.space, form.id).then(
      (r) => {
        if (!live) return
        setRows(r.answers)
        countRef.current(r.answers.length)
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Couldn’t load answers'),
    )
    formsApi.list().then(
      (r) => live && setCanSummarize(r.canSummarize),
      () => {},
    )
    return () => {
      live = false
    }
  }, [form.space, form.id])

  const download = async () => {
    try {
      const blob = await formsApi.csv(form.space, form.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${form.title.replace(/[^\w .-]+/g, '').trim() || 'answers'}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t download')
    }
  }

  const summarize = async () => {
    setSummarizing(true)
    setError(null)
    try {
      setSummary(await formsApi.summarize(form.space, form.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t summarize')
    } finally {
      setSummarizing(false)
    }
  }

  const row = rows?.find((r) => r.id === open) ?? null
  const close = () => {
    params.delete('answer')
    setParams(params, { replace: true })
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-24 md:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-ink-soft" data-testid="answers-count">
          {rows === null
            ? 'Loading…'
            : `${rows.length} ${rows.length === 1 ? 'answer' : 'answers'}`}
        </p>
        {canSummarize ? (
          <button
            type="button"
            className={primaryButton}
            disabled={summarizing || !rows?.length}
            onClick={() => void summarize()}
            data-testid="answers-summarize"
          >
            <Icon name="sparkle" />
            {summarizing ? 'Summarizing…' : 'Summarize answers'}
          </button>
        ) : null}
        <button
          type="button"
          className={secondaryButton}
          disabled={!rows?.length}
          onClick={() => void download()}
          data-testid="answers-csv"
        >
          <Icon name="download" />
          Download CSV
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
          {error}
        </p>
      ) : null}
      {summary ? <SummaryPanel form={form} summary={summary} /> : null}
      {rows && rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-ash-strong p-8 text-center">
          <p className="text-ink" data-testid="answers-empty">
            No answers yet.
          </p>
          <p className="mt-1 text-sm text-ink-faint">
            Send people the link: <span className="break-all">{form.url}</span>
          </p>
        </div>
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-xl border border-ash">
          <table className="w-full min-w-[36rem] text-left text-sm" data-testid="answers-table">
            <thead className="bg-paper-sunk text-xs text-ink-soft">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Sent</th>
                <th className="px-3 py-2 font-medium">From</th>
                {form.questions.slice(0, 6).map((q) => (
                  <th key={q.id} className="max-w-48 truncate px-3 py-2 font-medium">
                    {q.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ash/70">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer hover:bg-paper-sunk"
                  data-testid="answer-row"
                  onClick={() => setParams({ answer: r.id }, { replace: true })}
                >
                  <td className="px-3 py-2 whitespace-nowrap text-ink-soft">{when(r.submitted)}</td>
                  <td className="max-w-40 truncate px-3 py-2 text-ink-soft">
                    {r.submittedBy ?? 'Someone outside'}
                  </td>
                  {form.questions.slice(0, 6).map((q) => (
                    <td key={q.id} className="max-w-48 truncate px-3 py-2 text-ink">
                      {displayValue(r.answers[q.id])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {row ? (
        <AnswerDialog
          form={form}
          row={row}
          onClose={close}
          onDeleted={() => {
            const next = (rows ?? []).filter((r) => r.id !== row.id)
            setRows(next)
            onCount(next.length)
            close()
          }}
        />
      ) : null}
    </div>
  )
}

function SummaryPanel({ form, summary }: { form: FormView; summary: Summary }) {
  return (
    <section
      className="mt-5 rounded-xl border border-ash bg-paper-raised p-4 md:p-5"
      data-testid="answers-summary"
    >
      {summary.tallies.length > 0 ? (
        <div className="grid gap-5 md:grid-cols-2">
          {summary.tallies.map((t) => {
            const q = form.questions.find((x) => x.id === t.question)
            if (!q) return null
            return (
              <div key={t.question}>
                <h3 className="text-sm font-medium text-ink">{q.label}</h3>
                {t.counts ? (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {t.counts.map((c) => {
                      const pct = t.answered ? Math.round((c.count / t.answered) * 100) : 0
                      return (
                        <li key={c.option} className="text-sm">
                          <div className="flex justify-between gap-2 text-ink-soft">
                            <span className="truncate">{c.option}</span>
                            <span className="shrink-0 tabular-nums">{c.count}</span>
                          </div>
                          <div className="mt-0.5 h-1.5 rounded-full bg-paper-sunk">
                            <div
                              className="h-1.5 rounded-full bg-ember"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-ink-soft">
                    Average <span className="font-medium text-ink tabular-nums">{t.average}</span>{' '}
                    of {q.scale ?? 5}, from {t.answered}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
      {summary.summary ? (
        <div className={summary.tallies.length > 0 ? 'mt-5 border-t border-ash/70 pt-4' : ''}>
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-faint">
            <Icon name="sparkle" className="size-3.5" />
            Claude’s summary of{' '}
            {summary.read === summary.total ? 'all' : `the newest ${summary.read} of`}{' '}
            {summary.total} answers
          </p>
          <div className="mt-2 text-sm leading-relaxed text-ink [&_li]:ml-5 [&_li]:list-disc [&_p]:my-1.5 [&_strong]:font-semibold [&_ul]:my-1.5">
            <Markdown>{summary.summary}</Markdown>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function AnswerDialog({
  form,
  row,
  onClose,
  onDeleted,
}: {
  form: FormView
  row: AnswerRow
  onClose: () => void
  onDeleted: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  return (
    <Dialog
      title={`Answer from ${row.submittedBy ?? 'someone outside'}`}
      onClose={onClose}
      testId="answer-dialog"
      wide
    >
      <p className="text-sm text-ink-faint">Sent {when(row.submitted)}</p>
      <dl className="mt-4 flex flex-col gap-4">
        {form.questions.map((q) => {
          const v = row.answers[q.id]
          if (v === undefined) return null
          return (
            <div key={q.id}>
              <dt className="text-sm font-medium text-ink-soft">{q.label}</dt>
              <dd className="mt-1 whitespace-pre-line text-ink">
                {isFiles(v) ? (
                  <ul className="flex flex-col gap-1">
                    {v.map((f) => (
                      <li key={f.id}>
                        <Link
                          to={`/files/${encodeURIComponent(form.space)}/${f.id}`}
                          className="inline-flex items-center gap-1.5 text-ember-strong underline"
                          data-testid="answer-file"
                        >
                          <Icon name="paperclip" className="size-4" />
                          {f.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  displayValue(v)
                )}
              </dd>
            </div>
          )
        })}
      </dl>
      {error ? <p className="mt-3 text-sm text-ember-strong">{error}</p> : null}
      <div className="mt-6 flex justify-end gap-2">
        {confirm ? (
          <>
            <span className="mr-auto self-center text-sm text-ink-soft">Delete this answer?</span>
            <button type="button" className={secondaryButton} onClick={() => setConfirm(false)}>
              Keep it
            </button>
            <button
              type="button"
              className={primaryButton}
              data-testid="answer-delete-confirm"
              onClick={() =>
                formsApi
                  .removeAnswer(form.space, form.id, row.id)
                  .then(onDeleted, (e: unknown) =>
                    setError(e instanceof Error ? e.message : 'Couldn’t delete'),
                  )
              }
            >
              Delete
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${secondaryButton} mr-auto`}
            data-testid="answer-delete"
            onClick={() => setConfirm(true)}
          >
            <Icon name="trash" />
            Delete answer
          </button>
        )}
      </div>
    </Dialog>
  )
}
