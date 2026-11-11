import { parseFrontmatter } from '@hearth/format'
import { useEffect, useMemo, useRef, useState } from 'react'
import { HearthApiError } from '../../../api/client'
import { type AudioTrack, meetingsApi } from '../../../api/meetings'
import { Icon } from '../../../components/Icon'
import type { DocumentHandle } from '../../../hooks/useDocument'
import { attendeeName, dayLabel, timeLabel } from '../format'
import { TemplateSelect, useTemplates } from './common'

export interface MeetingMeta {
  id: string | null
  isMeeting: boolean
  date: Date | null
  durationMin: number | null
  attendees: string[]
  template: string | null
  /** The note has been through Enhance at least once. */
  enhanced: boolean
}

export function meetingMeta(text: string): MeetingMeta {
  const { data } = parseFrontmatter(text)
  const date = typeof data.date === 'string' ? new Date(data.date) : null
  const ranges = Array.isArray(data.ai_ranges) ? data.ai_ranges : []
  const models = typeof data.models === 'object' && data.models !== null ? data.models : {}
  return {
    id: typeof data.id === 'string' ? data.id : null,
    isMeeting: data.type === 'meeting',
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    durationMin: typeof data.duration_min === 'number' ? data.duration_min : null,
    attendees: Array.isArray(data.attendees) ? data.attendees.map(String) : [],
    template: typeof data.template === 'string' ? data.template : null,
    enhanced: ranges.length > 0 || 'enhance' in models,
  }
}

type Phase =
  | { name: 'idle' }
  | { name: 'enhancing' }
  /** The server refused: the note changed since it was enhanced. */
  | { name: 'confirm' }
  | { name: 'error'; message: string }

/**
 * Date, attendees, template, and Enhance (PRD §6.4): commit what's on screen, ask the server
 * to enhance, then adopt the enhanced note in place. Re-enhancing over edits asks first.
 */
export function MeetingHeader({
  doc,
  space,
  path,
  autoEnhance,
  onAutoEnhance,
  onEnhancing,
}: {
  doc: DocumentHandle
  space: string
  path: string
  /** Just stopped: enhance once, without a click (PRD §6.4). */
  autoEnhance: boolean
  onAutoEnhance: () => void
  /** An enhance started or ended; the page holds the editor read-only meanwhile. */
  onEnhancing: (running: boolean) => void
}) {
  const { state } = doc
  const templates = useTemplates()
  // biome-ignore lint/correctness/useExhaustiveDependencies: frontmatter can only change on these.
  const meta = useMemo(
    () => meetingMeta(doc.getText()),
    [doc.getText, state.loadKey, state.revision, state.lastCommittedAt],
  )
  const [picked, setPicked] = useState<string | null>(null)
  const template = picked ?? meta.template ?? 'general'
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })

  const enhance = async (force: boolean) => {
    setPhase({ name: 'enhancing' })
    // Read-only until the enhanced note is on screen: no keystroke can race the rewrite, and
    // the refetch below always finds the note clean, whatever was unsaved before.
    onEnhancing(true)
    try {
      // The server enhances what's in Git, so what's on screen goes there first.
      const saved = await doc.commit()
      if (saved === 'conflict' || saved === 'error') {
        setPhase({
          name: 'error',
          message: 'Your latest edits aren’t saved yet, so Enhance waited.',
        })
        return
      }
      await meetingsApi.enhance({ space, path, template, ...(force ? { force: true } : {}) })
      await doc.refetch()
      setPhase({ name: 'idle' })
    } catch (err) {
      if (err instanceof HearthApiError && err.status === 409) setPhase({ name: 'confirm' })
      else {
        setPhase({
          name: 'error',
          message: err instanceof Error ? err.message : 'Enhance didn’t finish. Try again.',
        })
      }
    } finally {
      onEnhancing(false)
    }
  }

  const autoRan = useRef(false)
  const ready = state.status === 'ready'
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the note is ready.
  useEffect(() => {
    if (!autoEnhance || !ready || autoRan.current) return
    autoRan.current = true
    onAutoEnhance()
    void enhance(false)
  }, [autoEnhance, ready])

  if (!ready || !meta.isMeeting) return null
  const enhancing = phase.name === 'enhancing'
  const names = meta.attendees.map(attendeeName)

  return (
    <div className="shrink-0 border-b border-ash/70 bg-paper-raised/35 py-2">
      {/* Same measure and padding as the editor's text, so the two line up. */}
      <div className="mx-auto w-full max-w-[var(--measure)] px-4 md:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="w-full min-w-0 text-sm text-ink-soft sm:w-auto sm:flex-1">
            {meta.date ? (
              <span className="font-medium text-ink">
                {dayLabel(meta.date)} · {timeLabel(meta.date)}
              </span>
            ) : null}
            {meta.durationMin !== null ? ` · ${meta.durationMin} min` : null}
            {names.length > 0 ? (
              <span className="block truncate" title={meta.attendees.join(', ')}>
                {names.join(', ')}
              </span>
            ) : null}
            {meta.id ? <KeptAudio space={space} id={meta.id} /> : null}
          </p>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <TemplateSelect
              templates={templates}
              value={template}
              onChange={setPicked}
              testId="enhance-template"
              disabled={enhancing}
              className="min-w-0 flex-1 sm:flex-none"
            />
            <button
              type="button"
              data-testid="enhance"
              disabled={enhancing}
              onClick={() => void enhance(false)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
            >
              <Icon name="sparkle" />
              {enhancing ? 'Enhancing…' : meta.enhanced ? 'Re-enhance' : 'Enhance'}
            </button>
          </div>
        </div>
        {phase.name === 'enhancing' ? (
          <p role="status" className="mt-1.5 text-xs text-ink-faint">
            Writing up your notes with the transcript. Your own lines stay as you typed them.
          </p>
        ) : null}
        {phase.name === 'confirm' ? (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ember/30 bg-ember-wash px-3 py-2 text-sm"
          >
            <span className="flex-1 text-ink">
              You edited this note after it was enhanced. Enhancing again replaces those edits.
            </span>
            <button
              type="button"
              onClick={() => void enhance(true)}
              className="font-medium text-ember-strong underline"
            >
              Re-enhance anyway
            </button>
            <button
              type="button"
              onClick={() => setPhase({ name: 'idle' })}
              className="text-ink-soft underline"
            >
              Keep my edits
            </button>
          </div>
        ) : null}
        {phase.name === 'error' ? (
          <p role="alert" className="mt-1.5 text-sm text-ember-strong">
            {phase.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

const TRACK_LABEL: Record<AudioTrack, string> = { me: 'your mic', them: 'the call' }

/** Downloads for the meeting's kept audio (PRD §6.9), when it was kept. */
function KeptAudio({ space, id }: { space: string; id: string }) {
  const [tracks, setTracks] = useState<AudioTrack[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    meetingsApi.keptAudio(space, id).then(
      (found) => live && setTracks(found),
      () => {},
    )
    return () => {
      live = false
    }
  }, [space, id])

  const download = async (track: AudioTrack) => {
    setError(null)
    try {
      const blob = await meetingsApi.audio(space, id, track)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${id}-${track}.wav`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The audio didn’t download.')
    }
  }

  if (tracks.length === 0) return null
  return (
    <span data-testid="kept-audio" className="block text-xs">
      Audio kept:{' '}
      {tracks.map((track, i) => (
        <span key={track}>
          {i > 0 ? ' · ' : null}
          <button type="button" className="underline" onClick={() => void download(track)}>
            {TRACK_LABEL[track]}
          </button>
        </span>
      ))}
      {error ? <span className="ml-2 text-ember-strong">{error}</span> : null}
    </span>
  )
}
