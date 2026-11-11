import {
  parseFrontmatter,
  parseTranscript,
  type TranscriptLine,
  transcriptPathFor,
} from '@hearth/format'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api, HearthApiError } from '../../../api/client'
import { hearthSocket } from '../../../api/ws'
import { SidePanel } from '../../../components/SidePanel'
import type { DocumentHandle } from '../../../hooks/useDocument'
import { meetingUrl } from '../../../lib/paths'
import { formatClock } from '../format'

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; lines: TranscriptLine[] }
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
        if (!cancelled) setLoaded({ status: 'ready', lines: parseTranscript(file.content) })
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
          <ol className="px-4 py-2">
            {loaded.lines.map((line, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are fixed once saved.
                key={i}
                className="grid grid-cols-[3.25rem_1fr] gap-x-2 py-1 text-sm"
              >
                <span
                  className={`text-xs leading-6 font-semibold ${line.speaker === 'Me' ? 'text-ember-strong' : 'text-moss'}`}
                >
                  {line.speaker}
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
