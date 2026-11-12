import {
  parseFrontmatter,
  parseTranscript,
  type TranscriptLine,
  transcriptPathFor,
} from '@hearth/format'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api, HearthApiError } from '../../../api/client'
import { meetingsApi } from '../../../api/meetings'
import { hearthSocket } from '../../../api/ws'
import { SidePanel } from '../../../components/SidePanel'
import type { DocumentHandle } from '../../../hooks/useDocument'
import { meetingUrl } from '../../../lib/paths'
import { formatClock } from '../format'

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; lines: TranscriptLine[]; blobOid: string }
  | { status: 'missing' }
  | { status: 'error'; message: string }

/** The transcript the note's frontmatter `transcript` names, read-only beside the note. */
export function TranscriptPanel({
  space,
  notePath,
  doc,
  onClose,
}: {
  space: string
  notePath: string
  doc: DocumentHandle
  onClose: () => void
}) {
  const { state, getText } = doc
  // Undefined until the note has loaded; null when it names no transcript.
  // biome-ignore lint/correctness/useExhaustiveDependencies: frontmatter can only change on these.
  const path = useMemo(
    () =>
      state.status === 'ready'
        ? transcriptPathFor(notePath, parseFrontmatter(getText()).data)
        : undefined,
    [notePath, getText, state.status, state.loadKey, state.revision, state.lastCommittedAt],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: frontmatter can only change on these.
  const who = useMemo(
    () => (state.status === 'ready' ? whoIsWho(parseFrontmatter(getText()).data) : NO_ONE),
    [getText, state.status, state.loadKey, state.revision, state.lastCommittedAt],
  )
  const [naming, setNaming] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const rename = async (names: Record<string, string>) => {
    setSaving(true)
    setNameError(null)
    try {
      // The labels as shown: if the transcript changed since (cleaned up after the call), the
      // server refuses rather than name whoever has that label now.
      const seen = loaded.status === 'ready' ? loaded.blobOid : undefined
      await meetingsApi.nameSpeakers(space, notePath, names, seen)
      setNaming(null)
    } catch (err) {
      setNameError(
        err instanceof HearthApiError && err.status === 409 && /cleaned up/.test(err.message)
          ? 'We’re still tidying this transcript. Try again in a moment.'
          : err instanceof HearthApiError && err.status === 409
            ? 'The transcript changed meanwhile. Look again, then try once more.'
            : err instanceof HearthApiError
              ? err.message
              : 'The name didn’t save.',
      )
    } finally {
      setSaving(false)
    }
  }
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refetch trigger.
  useEffect(() => {
    if (path === undefined) return
    if (path === null) {
      setLoaded({ status: 'missing' })
      return
    }
    let cancelled = false
    api.readFile(space, path).then(
      (file) => {
        if (!cancelled)
          setLoaded({
            status: 'ready',
            lines: parseTranscript(file.content),
            blobOid: file.blobOid,
          })
      },
      (err: unknown) => {
        if (cancelled) return
        if (err instanceof HearthApiError && err.status === 404) setLoaded({ status: 'missing' })
        else setLoaded({ status: 'error', message: 'The transcript didn’t load.' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [space, path, version])

  useEffect(() => {
    const off = hearthSocket.onChanged((event) => {
      if (event.space === space && path && event.paths.includes(path)) setVersion((v) => v + 1)
    })
    return () => {
      off()
    }
  }, [space, path])

  return (
    <SidePanel title="Transcript" onClose={onClose} testId="transcript-panel">
      {loaded.status === 'loading' ? (
        <p className="px-4 py-3 text-sm text-ink-faint">Loading the transcript…</p>
      ) : null}
      {loaded.status === 'missing' ? (
        <p className="px-4 py-3 text-sm text-ink-soft">
          This meeting has no transcript, or it wasn’t shared with the note.
        </p>
      ) : null}
      {loaded.status === 'error' ? (
        <p className="px-4 py-3 text-sm text-ember-strong">{loaded.message}</p>
      ) : null}
      {loaded.status === 'ready' && path ? (
        <>
          <WhoIsWho
            speakers={speakersIn(loaded.lines)}
            guesses={who.guesses}
            naming={naming}
            attendees={who.attendees}
            saving={saving}
            error={nameError}
            onName={setNaming}
            onSave={rename}
          />
          <ol className="px-4 py-2">
            {loaded.lines.map((line, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are fixed once saved.
                key={i}
                className="grid grid-cols-[6rem_1fr] gap-x-2 py-1 text-sm"
              >
                <span
                  className={`text-xs leading-6 font-semibold ${line.speaker === 'Me' ? 'text-ember-strong' : 'text-moss'}`}
                >
                  {line.speaker === 'Me' ? (
                    line.speaker
                  ) : (
                    <button
                      type="button"
                      className="max-w-full truncate text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
                      title={`Name ${line.speaker}`}
                      data-testid="speaker-label"
                      onClick={() => setNaming(line.speaker)}
                    >
                      {line.speaker}
                    </button>
                  )}
                  <span className="block font-mono text-[0.68rem] leading-3 font-normal text-ink-faint">
                    {formatClock(line.at * 1000)}
                  </span>
                </span>
                <span className="leading-6 text-ink">{line.text}</span>
              </li>
            ))}
          </ol>
          <Link
            to={meetingUrl(space, path)}
            className="mx-4 mb-4 inline-block text-sm text-ember-strong underline"
          >
            Open the transcript file
          </Link>
        </>
      ) : null}
    </SidePanel>
  )
}

const NO_ONE = { attendees: [] as string[], guesses: {} as Record<string, string> }

/** The attendees' display names and Claude's guesses at who each unnamed speaker is. */
function whoIsWho(data: Record<string, unknown>): typeof NO_ONE {
  const attendees = Array.isArray(data.attendees)
    ? data.attendees
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.replace(/\s*<[^>]*>\s*$/, '').trim())
        .filter((a) => a !== '' && !a.includes('@'))
    : []
  const raw = data.speaker_guesses
  const guesses: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [label, name] of Object.entries(raw)) {
      if (typeof name === 'string' && name.trim()) guesses[label] = name.trim()
    }
  }
  return { attendees, guesses }
}

/** Every speaker but the note-taker, in first-heard order. */
function speakersIn(lines: TranscriptLine[]): string[] {
  const out: string[] = []
  for (const l of lines) if (l.speaker !== 'Me' && !out.includes(l.speaker)) out.push(l.speaker)
  return out
}

/**
 * Above the transcript: Claude's guesses to confirm with one click, and, while a label is being
 * named, the attendees to pick from or a name to type.
 */
function WhoIsWho({
  speakers,
  guesses,
  naming,
  attendees,
  saving,
  error,
  onName,
  onSave,
}: {
  speakers: string[]
  guesses: Record<string, string>
  naming: string | null
  attendees: string[]
  saving: boolean
  error: string | null
  onName: (label: string | null) => void
  onSave: (names: Record<string, string>) => void
}) {
  const [typed, setTyped] = useState('')
  const open = Object.fromEntries(
    Object.entries(guesses).filter(([label]) => speakers.includes(label)),
  )
  const unnamed = speakers.filter((s) => /^Speaker \d+$/.test(s))
  if (naming === null && Object.keys(open).length === 0 && unnamed.length === 0) {
    return error ? <p className="px-4 pt-3 text-sm text-ember-strong">{error}</p> : null
  }
  return (
    <div
      className="mx-4 mt-3 rounded-md border border-ash bg-paper-sunk px-3 py-2 text-sm"
      data-testid="who-is-who"
    >
      {naming === null ? (
        <>
          <p className="font-semibold text-ink">Who’s who?</p>
          {Object.keys(open).length > 0 ? (
            <ul className="mt-1 space-y-1">
              {Object.entries(open).map(([label, name]) => (
                <li key={label} className="flex flex-wrap items-center gap-x-2">
                  <span className="text-ink-soft">
                    {label} sounds like <span className="text-ink">{name}</span>
                  </span>
                  <button
                    type="button"
                    disabled={saving}
                    className="text-ember-strong underline"
                    onClick={() => onSave({ [label]: name })}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="text-ink-soft underline"
                    onClick={() => onName(label)}
                  >
                    Someone else
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-ink-soft">Click a speaker’s label to give them a name.</p>
          )}
          {Object.keys(open).length > 1 ? (
            <button
              type="button"
              disabled={saving}
              className="mt-2 rounded bg-ember px-2 py-1 text-xs font-semibold text-paper-raised"
              onClick={() => onSave(open)}
            >
              Confirm all
            </button>
          ) : null}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim()) onSave({ [naming]: typed.trim() })
            setTyped('')
          }}
        >
          <p className="font-semibold text-ink">Who is {naming}?</p>
          {attendees.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {attendees.map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled={saving}
                  className="rounded-full border border-ash px-2 py-0.5 text-xs hover:border-ember"
                  onClick={() => {
                    setTyped('')
                    onSave({ [naming]: a })
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex gap-2">
            <input
              id="speaker-name"
              aria-label="Name"
              className="min-w-0 flex-1 rounded border border-ash bg-paper-raised px-2 py-1 text-sm"
              placeholder="Or type a name"
              value={typed}
              maxLength={60}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button
              type="submit"
              disabled={saving || typed.trim() === ''}
              className="rounded bg-ember px-2 py-1 text-xs font-semibold text-paper-raised"
            >
              Save
            </button>
            <button
              type="button"
              className="text-xs text-ink-soft underline"
              onClick={() => {
                setTyped('')
                onName(null)
              }}
            >
              Cancel
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            The name replaces {naming} in the transcript and in Claude’s part of the note.
          </p>
        </form>
      )}
      {error ? <p className="mt-1 text-ember-strong">{error}</p> : null}
    </div>
  )
}
