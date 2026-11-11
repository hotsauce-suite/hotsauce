import { type FormEvent, Fragment, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { meetingsApi } from '../../../api/meetings'
import type { ChatAnswer, ChatCitation, ChatScope } from '../../../api/types'
import { Icon } from '../../../components/Icon'
import { meetingUrl } from '../../../lib/paths'
import { isTranscriptPath, meetingLabel } from '../format'

interface Turn {
  id: number
  question: string
  status: 'pending' | 'done' | 'error'
  answer?: ChatAnswer
  error?: string
}

/** Where a citation opens: the cited file, with the cursor on the cited line. */
export function citationUrl(citation: ChatCitation): string {
  return `${meetingUrl(citation.space, citation.path)}#L${citation.line}`
}

/** The answer text with its `[n]` markers linked to the matching citation. */
function AnswerText({ answer }: { answer: ChatAnswer }) {
  // Each part is keyed by where it starts in the answer.
  let offset = 0
  const parts = answer.answer.split(/(\[\d+\])/).map((text) => {
    const part = { text, at: offset }
    offset += text.length
    return part
  })
  return (
    <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed text-ink">
      {parts.map(({ text, at }) => {
        const n = /^\[(\d+)\]$/.exec(text)?.[1]
        const citation = n ? answer.citations[Number(n) - 1] : undefined
        if (!citation) return <Fragment key={at}>{text}</Fragment>
        return (
          <Link
            key={at}
            to={citationUrl(citation)}
            className="mx-0.5 align-super font-mono text-[0.7rem] text-ember-strong no-underline hover:underline"
          >
            {n}
          </Link>
        )
      })}
    </p>
  )
}

function Citations({ citations }: { citations: ChatCitation[] }) {
  if (citations.length === 0) return null
  return (
    <ol className="mt-2.5 space-y-1">
      {citations.map((c, i) => (
        <li key={`${c.space}:${c.path}:${c.line}`}>
          <Link
            data-testid="chat-citation"
            to={citationUrl(c)}
            className="group flex gap-2 rounded-lg border border-ash/70 bg-paper/60 px-2.5 py-1.5 text-sm hover:border-ember"
          >
            <span className="font-mono text-xs leading-5 text-ember-strong">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-ink">
                {meetingLabel(c.path)}
                <span className="text-ink-faint">
                  {isTranscriptPath(c.path) ? ' · transcript' : ''} · line {c.line}
                </span>
              </span>
              <span className="block truncate text-ink-soft">{c.text}</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}

let turnId = 0

/**
 * Questions about meetings and answers with citations (`POST /api/meetings/chat`). Docked
 * under a meeting note it's a single ask bar whose conversation opens above it; on the Ask
 * page it fills the page.
 */
export function ChatPanel({
  scope,
  placeholder,
  variant,
  intro,
}: {
  scope: ChatScope
  placeholder: string
  variant: 'dock' | 'page'
  intro?: string
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const scopeKey = JSON.stringify(scope)

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to each new turn or answer.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  const ask = async (event?: FormEvent) => {
    event?.preventDefault()
    const question = draft.trim()
    if (!question) return
    turnId += 1
    const id = turnId
    setTurns((list) => [...list, { id, question, status: 'pending' }])
    setDraft('')
    const update = (patch: Partial<Turn>) =>
      setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    try {
      update({ status: 'done', answer: await meetingsApi.chat(question, JSON.parse(scopeKey)) })
    } catch (err) {
      update({
        status: 'error',
        error: err instanceof Error ? err.message : 'No answer came back.',
      })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void ask()
    }
  }

  const conversation = (
    <ol className="space-y-5">
      {turns.map((turn) => (
        <li key={turn.id}>
          <p className="mb-1.5 text-sm font-medium text-ink-soft">{turn.question}</p>
          {turn.status === 'pending' ? (
            <p className="text-sm text-ink-faint">Reading your meetings…</p>
          ) : null}
          {turn.status === 'error' ? (
            <p className="text-sm text-ember-strong">{turn.error}</p>
          ) : null}
          {turn.answer ? (
            <div data-testid="chat-answer">
              <AnswerText answer={turn.answer} />
              <Citations citations={turn.answer.citations} />
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )

  const form = (
    <form
      onSubmit={(event) => void ask(event)}
      className="flex items-end gap-2 rounded-xl border border-ash bg-paper-raised px-3 py-2 shadow-[0_1px_2px_rgb(70_34_12/0.08)] focus-within:border-ember"
    >
      <Icon name="sparkle" className="mb-2 size-4 shrink-0 text-ember" />
      <textarea
        data-testid="meeting-chat-input"
        aria-label={placeholder}
        rows={1}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-32 min-h-8 flex-1 resize-none border-0 bg-transparent py-1.5 text-[0.95rem] text-ink placeholder:text-ink-faint focus-visible:shadow-none"
      />
      <button
        type="submit"
        data-testid="meeting-chat-send"
        disabled={!draft.trim()}
        className="h-8 shrink-0 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-40"
      >
        Ask
      </button>
    </form>
  )

  if (variant === 'page') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[var(--measure)] px-4 py-8 md:px-6">
            {turns.length === 0 && intro ? <p className="text-ink-soft">{intro}</p> : null}
            {conversation}
            <div ref={end} />
          </div>
        </div>
        <div className="shrink-0 border-t border-ash/70 bg-paper/85 px-4 py-3 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-[var(--measure)] md:px-2">{form}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-ash/70 bg-paper/85 py-2.5 backdrop-blur-sm">
      {/* The editor's measure and padding: the bar's edge lines up with the note's text. */}
      <div className="mx-auto w-full max-w-[var(--measure)] px-3 md:px-6">
        {turns.length > 0 ? (
          <div className="relative mb-2.5 max-h-[40vh] overflow-y-auto rounded-xl border border-ash bg-paper-raised/80 p-4">
            <button
              type="button"
              aria-label="Close the answers"
              onClick={() => setTurns([])}
              className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-lg text-ink-faint hover:bg-paper-sunk hover:text-ink"
            >
              <Icon name="close" className="size-3.5" />
            </button>
            {conversation}
            <div ref={end} />
          </div>
        ) : null}
        {form}
      </div>
    </div>
  )
}
