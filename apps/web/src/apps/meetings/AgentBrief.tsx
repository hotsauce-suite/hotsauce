import { useEffect, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import { type BriefState, briefApi } from '../../api/brief'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton, secondaryButton } from './components/common'

/** Questions that show what a brief is for; each is sent with "use my brief" in front. */
export const BRIEF_PROMPTS = [
  'What are my priorities right now?',
  'I’ve been out for a few days. What’s changed in my priorities, and who is waiting on me?',
  'Turn last week’s action items into a plan for this week.',
  'Who do I work with most, and what should I raise with each of them this week?',
  'Write my update for the week. Lead with what moved, and leave out anything that isn’t on my plate.',
  'Tell me what you think my job is right now, including the projects and the people. I’ll correct you.',
]

// The brief is written by a model from other people's words too: no images, and links open away.
const components: Components = {
  img: () => null,
  a: ({ href = '', children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; state: BriefState }

/** `/meetings/brief`: the member's agent brief, their corrections, and how agents use it. */
export default function AgentBrief() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [notes, setNotes] = useState('')
  const [writing, setWriting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = `Agent brief · ${product()} Meetings`
    let cancelled = false
    briefApi.get().then(
      (state) => {
        if (cancelled) return
        setLoad({ status: 'ready', state })
        setNotes(state.notes)
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: messageOf(err) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const state = load.status === 'ready' ? load.state : null
  const notesChanged = state !== null && notes !== state.notes

  const rewrite = async () => {
    setWriting(true)
    setError(null)
    setMessage(null)
    try {
      if (notesChanged) await briefApi.saveNotes(notes)
      const result = await briefApi.refresh()
      setLoad({ status: 'ready', state: { brief: result.brief, notes: result.notes } })
      setNotes(result.notes)
      if (result.status === 'empty') {
        setMessage(
          'Nothing to write from yet. Take notes in a meeting or add some tasks, and your brief will be here the next morning.',
        )
      }
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setWriting(false)
    }
  }

  const saveNotes = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await briefApi.saveNotes(notes)
      setLoad((l) => (l.status === 'ready' ? { ...l, state: { ...l.state, notes } } : l))
      setMessage('Saved. Your next brief will follow it.')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <MeetingsPageHeader title="Agent brief">
        <button
          type="button"
          data-testid="brief-rewrite"
          onClick={() => void rewrite()}
          disabled={writing || state === null}
          className={`${secondaryButton} h-8 px-3`}
        >
          <Icon name="restart" />
          {writing ? 'Writing…' : 'Rewrite now'}
        </button>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-6 md:pt-10">
          <h2 className="font-display text-[1.6rem] font-semibold tracking-tight">
            What your agents know about you
          </h2>
          <p className="mt-2 text-ink-soft">
            Every night, {product()} reads your last 30 days of meetings and your tasks and writes a
            short brief: your priorities, projects, the people you work with, your jargon and how
            you like to write. Claude reads it before helping you, so you don’t have to explain the
            background. Only you can see it.
          </p>

          {load.status === 'loading' ? (
            <p className="mt-8 text-sm text-ink-faint">Loading your brief…</p>
          ) : null}
          {load.status === 'error' ? (
            <p role="alert" className="mt-8 text-sm text-ember-strong">
              {load.message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" data-testid="brief-error" className="mt-4 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
          {message ? (
            <p data-testid="brief-message" className="mt-4 text-sm text-ink-soft">
              {message}
            </p>
          ) : null}
          {writing ? (
            <p className="mt-4 text-sm text-ink-soft">
              Writing your brief from your meetings. This takes about a minute.
            </p>
          ) : null}

          {state?.brief ? (
            <>
              <p data-testid="brief-written" className="mt-6 text-sm text-ink-faint">
                Written {when(state.brief.generated)} from {plural(state.brief.meetings, 'meeting')}{' '}
                and {plural(state.brief.tasks, 'task')}.
              </p>
              <article
                data-testid="brief-body"
                className="prose-hearth mt-3 rounded-xl border border-ash bg-paper-raised/60 brief-body"
                style={{ padding: '1.25rem 1.5rem', maxWidth: 'none' }}
              >
                <Markdown remarkPlugins={[remarkGfm]} components={components}>
                  {state.brief.body}
                </Markdown>
              </article>
            </>
          ) : state ? (
            <div
              data-testid="brief-empty"
              className="mt-6 rounded-xl border border-ash bg-paper-raised/60 p-5"
            >
              <p className="text-ink">You don’t have a brief yet.</p>
              <p className="mt-1 text-sm text-ink-soft">
                It’s written from your meetings and tasks. Write it now, or it’ll be here tomorrow
                morning.
              </p>
              <button
                type="button"
                data-testid="brief-write"
                onClick={() => void rewrite()}
                disabled={writing}
                className={`${primaryButton} mt-4`}
              >
                <Icon name="sparkle" />
                {writing ? 'Writing…' : 'Write my brief'}
              </button>
            </div>
          ) : null}

          {state ? (
            <section className="mt-10">
              <h3 className="text-sm font-semibold text-ink-soft">Correct it</h3>
              <p className="mt-1 text-sm text-ink-soft">
                Anything it got wrong, or should always know: your role, what to ignore, how you
                like to be written to. This always wins over what your meetings suggest.
              </p>
              <textarea
                data-testid="brief-notes"
                aria-label="Corrections for your brief"
                value={notes}
                maxLength={20_000}
                rows={4}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="For example: I lead growth, not sales. Ignore the hiring project, it’s done."
                className="mt-2 w-full rounded-lg border border-ash-strong bg-paper-raised p-3 text-sm text-ink focus:border-ember focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="brief-notes-save"
                  onClick={() => void saveNotes()}
                  disabled={!notesChanged || saving || writing}
                  className={`${secondaryButton} h-9 px-3`}
                >
                  Save
                </button>
                <button
                  type="button"
                  data-testid="brief-notes-rewrite"
                  onClick={() => void rewrite()}
                  disabled={!notesChanged || saving || writing}
                  className={`${primaryButton} h-9 px-3`}
                >
                  Save and rewrite
                </button>
              </div>
            </section>
          ) : null}

          <section className="mt-10">
            <h3 className="text-sm font-semibold text-ink-soft">Use it with Claude</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Connect Claude to {product()} once from{' '}
              <Link to="/settings" className="text-ember-strong underline">
                Settings
              </Link>
              . Claude then reads your brief before it starts. Try asking:
            </p>
            <ul data-testid="brief-prompts" className="mt-3 space-y-2">
              {BRIEF_PROMPTS.map((p) => (
                <PromptRow key={p} prompt={p} />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  )
}

function PromptRow({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false)
  const full = `Read my ${product()} agent brief first. ${prompt}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused (an insecure page or no permission): the text is on screen to select.
    }
  }
  return (
    <li className="flex items-center gap-2 rounded-lg border border-ash bg-paper-raised/60 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 text-ink">{prompt}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy “${prompt}”`}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-ink-soft hover:bg-paper hover:text-ink"
      >
        <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
        {copied ? 'Copied' : 'Copy'}
      </button>
      <a
        href={`https://claude.ai/new?q=${encodeURIComponent(full)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-ink-soft hover:bg-paper hover:text-ink"
      >
        <Icon name="external" className="size-3.5" />
        Ask Claude
      </a>
    </li>
  )
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'recently'
  const sameDay = date.toDateString() === new Date().toDateString()
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay
    ? `today at ${time}`
    : `${date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}
