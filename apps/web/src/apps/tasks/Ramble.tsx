import { parseQuickAdd } from '@hearth/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type TaskPerson, type TaskView, tasksApi } from '../../api/tasks'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { formatClock } from '../meetings/format'
import { chipsFor, lineFor } from './logic'
import {
  assignsSomeoneElse,
  ChipRow,
  QuickField,
  type SpaceChoice,
  SpaceSwitch,
  useParsed,
} from './QuickAdd'
import { errorMessage } from './useTaskList'
import { useProjects } from './useTaskMeta'

/** Ramble stops itself after five minutes. */
export const RAMBLE_MAX_MS = 5 * 60_000

const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav']

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return undefined
  return AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
}

interface Line {
  id: number
  text: string
  keep: boolean
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'thinking' }
  | { kind: 'review'; transcript: string }
  | { kind: 'failed'; message: string }

export interface RambleProps {
  today: string
  tz: string
  me: string | undefined
  people: readonly TaskPerson[]
  spaces: { personal: string | null; team: string | null }
  defaultSpace: SpaceChoice
  onClose: () => void
  onAdded: (task: TaskView) => void
  onError: (message: string) => void
}

/**
 * Ramble: say the tasks out loud. Records with MediaRecorder (up to 5 minutes, live timer),
 * sends the audio to `/api/tasks/ramble`, then shows each proposed task as an editable quick-add
 * line with a checkbox; "Add N tasks" adds the checked ones (`source.kind = voice`).
 */
export function Ramble(props: RambleProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [lines, setLines] = useState<Line[]>([])
  const [choice, setChoice] = useState<SpaceChoice>(props.defaultSpace)
  const [adding, setAdding] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const [live, setLive] = useState<MediaStream | null>(null)
  const discard = useRef(false)
  // Set when this Ramble goes away, so an add still running stops and never closes a new one.
  const closed = useRef(false)
  useEffect(
    () => () => {
      closed.current = true
    },
    [],
  )
  const { tz, today } = props

  // Start recording as soon as Ramble opens: the member pressed the mic to talk.
  useEffect(() => {
    let cancelled = false
    const chunks: Blob[] = []
    const start = async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          for (const t of media.getTracks()) t.stop()
          return
        }
        stream.current = media
        setLive(media)
        const mimeType = pickMimeType()
        const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
        recorder.current = rec
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        rec.onstop = () => {
          for (const t of stream.current?.getTracks() ?? []) t.stop()
          if (discard.current || cancelled) return
          const audio = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })
          setPhase({ kind: 'thinking' })
          tasksApi.ramble(audio, tz).then(
            (result) => {
              if (cancelled) return
              const reparse = (text: string) => parseQuickAdd(text, { today })
              setLines(
                result.tasks.map((t, i) => ({ id: i, text: lineFor(t, reparse), keep: true })),
              )
              setPhase({ kind: 'review', transcript: result.transcript })
            },
            (err: unknown) => {
              if (!cancelled) setPhase({ kind: 'failed', message: errorMessage(err) })
            },
          )
        }
        rec.start(1000)
        setPhase({ kind: 'recording', startedAt: Date.now() })
      } catch {
        if (!cancelled) {
          setPhase({
            kind: 'failed',
            message: `${product()} can’t use your microphone. Allow it in your browser’s settings.`,
          })
        }
      }
    }
    void start()
    return () => {
      cancelled = true
      if (recorder.current && recorder.current.state !== 'inactive') {
        discard.current = true
        recorder.current.stop()
      }
      for (const t of stream.current?.getTracks() ?? []) t.stop()
    }
  }, [tz, today])

  const stop = useCallback(() => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
  }, [])

  // The live timer, and the five-minute cap.
  useEffect(() => {
    if (phase.kind !== 'recording') return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t - phase.startedAt >= RAMBLE_MAX_MS) stop()
    }, 250)
    return () => clearInterval(timer)
  }, [phase, stop])

  const cancel = () => {
    discard.current = true
    stop()
    props.onClose()
  }

  const kept = lines.filter((l) => l.keep && l.text.trim())
  // Only a line that assigns someone else has to go to Team (a personal task is yours alone);
  // the others go where the switch says, so they stay in your own lists.
  const projects = useProjects()
  const forTeammate = (text: string) =>
    assignsSomeoneElse(parseQuickAdd(text, { today }), props.people, props.me)
  // A line filed under one of the team's projects (and none of yours) belongs with that project.
  const inTeamProject = (text: string) => {
    const project = parseQuickAdd(text, { today }).project?.toLowerCase()
    if (!project) return false
    const named = projects.filter((p) => p.name.toLowerCase() === project)
    return (
      named.some((p) => p.space === props.spaces.team) &&
      !named.some((p) => p.space === props.spaces.personal)
    )
  }
  const forcedTeam = kept.length > 0 && kept.every((l) => forTeammate(l.text))
  const someForTeammates = kept.some((l) => forTeammate(l.text))

  const addAll = async () => {
    setAdding(true)
    let failed = 0
    for (const line of kept) {
      if (closed.current) return
      const space =
        choice === 'team' || forTeammate(line.text) || inTeamProject(line.text)
          ? props.spaces.team
          : props.spaces.personal
      try {
        const body: Parameters<typeof tasksApi.quick>[0] = {
          text: line.text,
          tz,
          source: { kind: 'voice' },
        }
        if (space) body.space = space
        const task = await tasksApi.quick(body)
        props.onAdded(task)
        setLines((all) => all.filter((l) => l.id !== line.id))
      } catch (err) {
        // Keep going: the line that failed stays here to fix, the rest are added.
        failed += 1
        props.onError(errorMessage(err))
      }
    }
    if (closed.current) return
    setAdding(false)
    if (failed === 0) props.onClose()
  }

  return (
    <section
      data-testid="ramble"
      aria-label="Ramble"
      className="rounded-xl border border-ash bg-paper-raised px-4 py-3.5 shadow-float"
    >
      {phase.kind === 'starting' || phase.kind === 'recording' ? (
        <div className="flex items-center gap-3">
          <span
            className={`rec-dot ${phase.kind === 'recording' ? 'rec-dot-live' : ''}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[0.95rem] text-ink">
              {phase.kind === 'recording'
                ? 'Listening… say your tasks'
                : 'Starting the microphone…'}
            </span>
            {phase.kind === 'recording' ? (
              <RambleLevel stream={live} />
            ) : (
              <span className="block text-xs text-ink-faint">
                “Call Sam Friday at 3, then send the deck to Priya tomorrow, priority one.”
              </span>
            )}
          </span>
          <span
            data-testid="ramble-timer"
            className="font-mono text-[0.85rem] text-ink-soft tabular-nums"
          >
            {formatClock(phase.kind === 'recording' ? Math.max(0, now - phase.startedAt) : 0)}
          </span>
          <button
            type="button"
            onClick={cancel}
            className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="ramble-stop"
            disabled={phase.kind !== 'recording'}
            onClick={stop}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
          >
            <Icon name="stop" className="size-3.5" />
            Stop
          </button>
        </div>
      ) : null}

      {phase.kind === 'thinking' ? (
        <p data-testid="ramble-thinking" className="py-1 text-[0.95rem] text-ink-soft">
          Turning that into tasks…
        </p>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="flex-1 text-sm text-ember-strong">
            {phase.message}
          </p>
          <button
            type="button"
            onClick={props.onClose}
            className="inline-flex h-8 items-center rounded-lg border border-ash px-3 text-sm text-ink"
          >
            Close
          </button>
        </div>
      ) : null}

      {phase.kind === 'review' ? (
        <div data-testid="ramble-review">
          <h3 className="font-display text-lg font-semibold tracking-tight text-ink">
            {lines.length === 0
              ? 'No tasks heard'
              : `${lines.length} task${lines.length === 1 ? '' : 's'} heard`}
          </h3>
          {phase.transcript ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-ink-faint" title={phase.transcript}>
              “{phase.transcript}”
            </p>
          ) : null}
          {/* Nothing here changes while the tasks are being added. */}
          <fieldset disabled={adding} className="contents">
            <ul className="mt-3 space-y-2">
              {lines.map((line) => (
                <RambleLine
                  key={line.id}
                  line={line}
                  today={today}
                  onChange={(next) =>
                    setLines((all) => all.map((l) => (l.id === line.id ? { ...l, ...next } : l)))
                  }
                />
              ))}
            </ul>
          </fieldset>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ash/70 pt-3">
            <SpaceSwitch value={choice} onChange={setChoice} forcedTeam={forcedTeam} />
            {someForTeammates && !forcedTeam && choice !== 'team' ? (
              <span data-testid="ramble-team-note" className="text-xs text-ink-faint">
                Tasks for teammates go to Team
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={props.onClose}
                disabled={adding}
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="ramble-add"
                disabled={kept.length === 0 || adding}
                onClick={() => void addAll()}
                className="inline-flex h-8 items-center rounded-lg bg-ember px-3.5 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {`Add ${kept.length} task${kept.length === 1 ? '' : 's'}`}
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function RambleLine({
  line,
  today,
  onChange,
}: {
  line: Line
  today: string
  onChange: (next: Partial<Line>) => void
}) {
  const parsed = useParsed(line.text, today)
  return (
    <li
      data-testid="ramble-line"
      className={`flex items-start gap-2.5 rounded-lg border border-ash/70 bg-paper/60 px-3 py-1 ${line.keep ? '' : 'opacity-55'}`}
    >
      <input
        type="checkbox"
        checked={line.keep}
        aria-label={`Add: ${line.text}`}
        onChange={(e) => onChange({ keep: e.target.checked })}
        className="mt-3 size-4 shrink-0 accent-ember"
      />
      <div className="min-w-0 flex-1 pb-1.5">
        <QuickField
          value={line.text}
          onChange={(text) => onChange({ text })}
          parsed={parsed}
          label="Proposed task"
          testId="ramble-line-input"
        />
        <ChipRow chips={chipsFor(parsed, today)} />
      </div>
    </li>
  )
}

/** How loud counts as hearing you (peak of the waveform, 0 to 1). */
const HEARD_LEVEL = 0.04
/** How long without sound before Ramble says it hears nothing. */
const SILENT_MS = 3000
const BARS = ['b1', 'b2', 'b3', 'b4', 'b5'] as const

/**
 * Bars that move with the microphone, and a word on what it hears: "Hearing you" once there is
 * sound, or a nudge to check the microphone if it has heard nothing in the first three seconds.
 */
export function RambleLevel({ stream }: { stream: MediaStream | null }) {
  const bars = useRef<HTMLSpanElement>(null)
  const [heard, setHeard] = useState<'waiting' | 'heard' | 'silent'>('waiting')
  useEffect(() => {
    if (!stream || typeof AudioContext === 'undefined') return
    if (typeof stream.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) return
    // The meter is a nicety: if the browser won't analyse the stream, recording still works.
    let context: AudioContext
    let analyser: AnalyserNode
    try {
      context = new AudioContext()
      // Started after an await, so a browser may create it suspended; it has to run to measure.
      void context.resume().catch(() => {})
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
    } catch {
      return
    }
    const data = new Uint8Array(analyser.fftSize)
    const started = performance.now()
    let lastSound = 0
    let state: 'waiting' | 'heard' | 'silent' = 'waiting'
    let frame = 0
    const draw = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
      const level = peak / 128
      const t = performance.now()
      if (level >= HEARD_LEVEL) lastSound = t
      // Once it has heard you, a pause to think is just a pause. Only a microphone that has
      // never picked anything up, while the meter is really measuring, gets the warning.
      const next =
        lastSound > 0
          ? 'heard'
          : context.state === 'running' && t - started >= SILENT_MS
            ? 'silent'
            : state
      if (next !== state) {
        state = next
        setHeard(next)
      }
      const lit = Math.round(Math.min(1, level * 3) * BARS.length)
      const spans = bars.current?.children
      if (spans) {
        for (let i = 0; i < spans.length; i++) {
          ;(spans[i] as HTMLElement).dataset.on = i < lit ? 'true' : 'false'
        }
      }
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      void context.close().catch(() => {})
    }
  }, [stream])
  return (
    <span className="mt-1 flex items-center gap-2 text-xs" data-testid="ramble-level">
      <span ref={bars} className="ramble-bars" aria-hidden="true">
        {BARS.map((id) => (
          <span key={id} data-on="false" />
        ))}
      </span>
      <span
        data-testid="ramble-heard"
        data-state={heard}
        className={heard === 'silent' ? 'text-ember-strong' : 'text-ink-faint'}
      >
        {heard === 'heard'
          ? 'Hearing you'
          : heard === 'silent'
            ? 'No sound from your microphone. Check it’s the right one and not muted.'
            : 'Say something…'}
      </span>
    </span>
  )
}
