import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import { type DictationWords, dictationApi } from '../../api/dictation'
import { meetingsApi } from '../../api/meetings'
import type { MeetingSession, MeetingSummary, TranscriptSegment } from '../../api/types'
import { org, product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MAC_APP_SETTINGS } from '../../components/MacApp'
import { useShortcut } from '../../keyboard/shortcuts'
import { meetingUrl } from '../../lib/paths'
import { CaptureError, captureAudio } from '../meetings/audio/capture'
import type { MeetingSocket } from '../meetings/audio/socket'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { LiveTranscript } from '../meetings/components/LiveTranscript'
import { useNow } from '../meetings/components/RecordingIndicator'
import { dayLabel, formatClock, timeLabel } from '../meetings/format'
import { beginLive, currentLive, type LiveMeeting, stopSession } from '../meetings/live/controller'
import { type LiveSnapshot, useLive } from '../meetings/live/liveState'
import { WordEditor } from './DictatePage'

/** The Meetings template a voice note is recorded with (server: VOICE_NOTE_TEMPLATE). */
export const VOICE_NOTE_TEMPLATE = 'voice-note'
/** How many recent voice notes the page lists. */
const RECENT = 20

/** No audio for this long while recording means the phone took the microphone away. */
const STALL_MS = 2500
/** Exact digital silence for this long means the same (iPhone after a call or Siri). */
const SILENT_MS = 5000

type Phase = { name: 'idle' } | { name: 'starting' } | { name: 'error'; message: string }

/**
 * `/dictate/voice`: Hearth Dictate on a phone. One big button records a voice note through the
 * Meetings recorder (mic only, saved in the member's personal space). Stopping opens the note,
 * which Enhance turns into a title, a summary, to-dos and the clean transcript.
 */
export default function VoiceNotes() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const live = useLive()
  const meeting = currentLive()
  const recordingHere =
    live !== null && meeting?.session.id === live.id && isVoiceNote(meeting.session)
  // Another meeting (a call in Meetings) is being recorded on this page.
  const otherMeeting = live !== null && !recordingHere ? live : null
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [notes, setNotes] = useState<MeetingSummary[] | null>(null)
  const [unsaved, setUnsaved] = useState<MeetingSession[]>([])
  // The voice note last recorded here, so a stop from another device can be explained.
  const lastHere = useRef<LiveMeeting | null>(null)
  if (recordingHere && meeting) lastHere.current = meeting
  const endedElsewhere = !recordingHere ? (lastHere.current?.endedElsewhere ?? null) : null

  useEffect(() => {
    document.title = `Voice notes · ${product()} Dictate`
  }, [])

  const refresh = useCallback(() => {
    meetingsApi.list().then(
      (list) => setNotes(list.filter((m) => m.template === VOICE_NOTE_TEMPLATE).slice(0, RECENT)),
      () => setNotes([]),
    )
    meetingsApi.unsavedSessions().then(
      (list) => setUnsaved(list.filter((s) => isVoiceNote(s))),
      () => {},
    )
  }, [])
  useEffect(refresh, [refresh])

  const start = useCallback(async () => {
    if (currentLive()) return
    setPhase({ name: 'starting' })
    let capture: Awaited<ReturnType<typeof captureAudio>> | null = null
    try {
      // The microphone first, straight from the tap: iPhone asks for it only during a gesture.
      capture = await captureAudio('mic-only')
      const created = await meetingsApi.createSession({
        template: VOICE_NOTE_TEMPLATE,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const recording = beginLive(created)
      await recording.attachCapture(capture)
      setPhase({ name: 'idle' })
    } catch (err) {
      capture?.stop()
      setPhase({ name: 'error', message: startError(err) })
    }
  }, [])

  // The home-screen shortcut ("New voice note") opens /dictate/voice?start=1: start at once.
  // Android allows the microphone without a tap once it was allowed before; if not, the button
  // is right there.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (params.get('start') !== '1' || autoStarted.current) return
    autoStarted.current = true
    setParams({}, { replace: true })
    if (!currentLive()) void start()
  }, [params, setParams, start])

  // r starts a voice note here; while one records, r stops and saves it (Recording below).
  useShortcut(
    'recording.toggle',
    () => void start(),
    !recordingHere && otherMeeting === null && phase.name !== 'starting',
  )

  const saveUnsaved = async (session: MeetingSession) => {
    try {
      const saved = await stopSession(session.id)
      navigate(meetingUrl(saved.space, saved.path), { state: { enhance: true } })
    } catch (err) {
      setPhase({ name: 'error', message: messageOf(err) })
    }
  }

  return (
    <>
      <MeetingsPageHeader title="Voice notes" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 pt-6 pb-28 md:px-8 md:pt-10">
          {recordingHere && meeting ? (
            <Recording meeting={meeting} live={live} />
          ) : (
            <section aria-labelledby="voice-title" className="flex flex-col items-center pt-4">
              <h2
                id="voice-title"
                className="text-center font-display text-[1.7rem] leading-tight font-semibold tracking-tight text-ink"
              >
                Say it out loud.
              </h2>
              <p className="mt-2 max-w-[22rem] text-center text-sm text-ink-soft">
                Record a thought, a to-do list, or a meeting in the room. {product()} writes it up
                with a title, a summary, your to-dos and the full transcript.
              </p>
              <button
                type="button"
                data-testid="voice-record"
                onClick={() => void start()}
                disabled={phase.name === 'starting' || otherMeeting !== null}
                aria-label="Record a voice note"
                className="voice-record mt-8"
              >
                <Icon name="mic" className="size-10" />
              </button>
              <p className="mt-4 text-sm font-medium text-ink" aria-live="polite">
                {phase.name === 'starting' ? 'Starting…' : 'Tap to record'}
              </p>
              {otherMeeting ? (
                <p className="mt-4 rounded-lg bg-paper-sunk px-3 py-2 text-center text-sm text-ink-soft">
                  A meeting is recording.{' '}
                  <Link
                    to={`/meetings/live/${encodeURIComponent(otherMeeting.id)}`}
                    className="font-medium text-ink underline underline-offset-2"
                  >
                    Open it
                  </Link>{' '}
                  to stop it before you record a voice note.
                </p>
              ) : null}
            </section>
          )}

          {phase.name === 'error' ? (
            <p
              role="alert"
              data-testid="voice-error"
              className="mt-6 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink"
            >
              {phase.message}
            </p>
          ) : null}

          {endedElsewhere ? (
            <p
              role="status"
              data-testid="voice-ended-elsewhere"
              className="mt-6 rounded-lg bg-paper-sunk px-3 py-2 text-sm text-ink-soft"
            >
              {endedElsewhere}
            </p>
          ) : null}

          {unsaved
            .filter((session) => session.id !== live?.id)
            .map((session) => (
              <div
                key={session.id}
                data-testid="voice-unsaved"
                className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-ash bg-paper-raised/70 p-3 text-sm"
              >
                <span className="min-w-0 flex-1 text-ink">
                  {session.state === 'stopped'
                    ? `“${session.title}” stopped before it was saved.`
                    : `“${session.title}” is still open. Open it to keep recording, or to stop and save it.`}
                </span>
                {session.state === 'stopped' ? (
                  <button
                    type="button"
                    onClick={() => void saveUnsaved(session)}
                    className={`${secondaryButton} h-9`}
                  >
                    Save it now
                  </button>
                ) : (
                  <Link
                    to={`/meetings/live/${encodeURIComponent(session.id)}`}
                    className={`${secondaryButton} h-9`}
                  >
                    Open it
                  </Link>
                )}
              </div>
            ))}

          <RecentNotes notes={notes} />
          <Words />

          <p className="mt-12 border-t border-ash/70 pt-4 text-center text-xs leading-relaxed text-ink-faint">
            On a Mac?{' '}
            <Link to={MAC_APP_SETTINGS} className="text-ink-soft underline underline-offset-2">
              Get the Mac app
            </Link>{' '}
            to dictate into any app.
          </p>
        </div>
      </div>
    </>
  )
}

function Recording({ meeting, live }: { meeting: LiveMeeting; live: LiveSnapshot }) {
  const navigate = useNavigate()
  const segments = useTranscript(meeting.socket)
  const [showTranscript, setShowTranscript] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const paused = live.state === 'paused'
  const ended = live.state === 'saved' || live.state === 'stopped'
  const { level, stalled } = useMicLevel(meeting, live.state === 'recording' && live.capturing)
  const micGone = !paused && !ended && (stalled || live.lostTrack === 'me' || !live.capturing)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)

  const resumeMic = async () => {
    setResuming(true)
    setResumeError(null)
    try {
      // From the tap: an iPhone gives the microphone back only during a gesture.
      await meeting.attachCapture(await captureAudio('mic-only'))
    } catch (err) {
      setResumeError(startError(err))
    } finally {
      setResuming(false)
    }
  }

  useShortcut('recording.toggle', () => void stop(), !stopping && !ended)
  useShortcut('recording.pause', () => void (paused ? meeting.resume() : meeting.pause()), !ended)

  const stop = async () => {
    setStopping(true)
    setStopError(null)
    try {
      // Keep audio follows the member's Meetings setting: Stop sends no choice of its own.
      const saved = await meeting.stop()
      navigate(meetingUrl(saved.space, saved.path), { state: { enhance: true } })
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'The voice note didn’t stop. Try again.')
      setStopping(false)
    }
  }

  return (
    <section
      aria-label="Recording a voice note"
      data-testid="voice-recording"
      data-state={live.state}
      className="flex flex-col items-center pt-2"
    >
      <p
        role="status"
        className="w-full rounded-lg bg-ember-wash px-3 py-2 text-center text-xs leading-relaxed text-ink"
      >
        Keep this screen open while you record. Locking your phone or switching apps stops the
        microphone; everything recorded up to then is kept.
      </p>
      <p className="mt-8 flex items-center gap-2 text-sm font-medium text-ink-soft">
        <span aria-hidden="true" className={`rec-dot ${paused ? '' : 'rec-dot-live'}`} />
        {paused ? 'Paused' : micGone ? 'Not hearing the microphone' : 'Recording'}
      </p>
      <Elapsed startedAt={live.startedAt} />
      <Wave level={level} flat={paused || micGone} />
      {micGone ? (
        <button
          type="button"
          data-testid="voice-resume-mic"
          onClick={() => void resumeMic()}
          disabled={resuming}
          className={`${primaryButton} mt-4 h-12 px-5`}
        >
          <Icon name="mic" />
          {resuming ? 'Starting…' : 'Tap to resume the microphone'}
        </button>
      ) : null}
      {resumeError ? (
        <p role="alert" className="mt-3 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink">
          {resumeError}
        </p>
      ) : null}
      {live.link === 'reconnecting' ? (
        <p className="mt-3 text-center text-xs text-ink-faint">
          Offline. Your voice is kept on this phone and sent when the connection is back.
        </p>
      ) : null}
      {live.error ? (
        <p role="alert" className="mt-3 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink">
          {live.error}
        </p>
      ) : null}

      <div className="mt-8 flex w-full max-w-xs items-center gap-3">
        <button
          type="button"
          data-testid="voice-pause"
          onClick={() => void (paused ? meeting.resume() : meeting.pause())}
          disabled={stopping || ended}
          className={`${secondaryButton} h-14 flex-1 text-base`}
        >
          <Icon name={paused ? 'play' : 'pause'} />
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          data-testid="voice-stop"
          onClick={() => void stop()}
          disabled={stopping || ended}
          className={`${primaryButton} h-14 flex-1 text-base`}
        >
          <Icon name="stop" />
          {stopping ? 'Saving…' : 'Done'}
        </button>
      </div>
      {stopError ? (
        <p role="alert" className="mt-4 rounded-lg bg-rust-wash px-3 py-2 text-sm text-ink">
          {stopError}
        </p>
      ) : null}

      <div className="mt-8 w-full overflow-hidden rounded-xl border border-ash">
        <button
          type="button"
          data-testid="voice-transcript-toggle"
          aria-expanded={showTranscript}
          onClick={() => setShowTranscript((v) => !v)}
          className="flex h-11 w-full items-center justify-between px-4 text-sm text-ink-soft hover:text-ink"
        >
          {showTranscript ? 'Hide transcript' : 'Show transcript'}
          <Icon name="transcript" className="size-4" />
        </button>
        {showTranscript ? (
          <LiveTranscript segments={segments} expanded onToggle={() => setShowTranscript(false)} />
        ) : null}
      </div>
    </section>
  )
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const now = useNow()
  return (
    <p
      data-testid="voice-elapsed"
      className="mt-1 font-mono text-5xl font-semibold tracking-tight text-ink tabular-nums"
    >
      {formatClock(Math.max(0, now - Date.parse(startedAt)))}
    </p>
  )
}

const BARS = 28
const FLAT = 0.08

/**
 * The microphone's level, from the very audio sent to the server (no second audio graph), and
 * whether that audio stopped coming while it should be: the phone took the microphone away.
 */
function useMicLevel(
  meeting: LiveMeeting,
  expecting: boolean,
): { level: { current: number }; stalled: boolean } {
  const level = useRef(FLAT)
  const lastFrame = useRef(Date.now())
  const lastSound = useRef(Date.now())
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    const listener = (track: string, pcm: Uint8Array) => {
      if (track !== 'me') return
      const now = Date.now()
      lastFrame.current = now
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
      let sum = 0
      for (const v of samples) sum += v * v
      const rms = samples.length ? Math.sqrt(sum / samples.length) / 32768 : 0
      if (rms > 0) lastSound.current = now
      level.current = Math.min(1, FLAT + rms * 4)
    }
    meeting.onAudio = listener
    return () => {
      if (meeting.onAudio === listener) meeting.onAudio = null
    }
  }, [meeting])

  useEffect(() => {
    if (!expecting) {
      setStalled(false)
      return
    }
    // Counting starts now: a pause or a fresh microphone isn't a stall.
    lastFrame.current = Date.now()
    lastSound.current = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      setStalled(now - lastFrame.current > STALL_MS || now - lastSound.current > SILENT_MS)
    }, 500)
    return () => clearInterval(timer)
  }, [expecting])

  return { level, stalled }
}

/** A moving sound wave from the microphone's level; flat while paused. */
function Wave({ level, flat }: { level: { current: number }; flat: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])
  useEffect(() => {
    if (flat) {
      for (const bar of bars.current) if (bar) bar.style.transform = `scaleY(${FLAT})`
      return
    }
    const levels = new Array<number>(BARS).fill(FLAT)
    let frame = 0
    let last = 0
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw)
      if (t - last < 70) return
      last = t
      levels.shift()
      levels.push(level.current)
      levels.forEach((value, i) => {
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleY(${value})`
      })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [flat, level])

  return (
    <div aria-hidden="true" data-testid="voice-wave" className="voice-wave mt-6">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars that never reorder.
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

function RecentNotes({ notes }: { notes: MeetingSummary[] | null }) {
  return (
    <section aria-labelledby="voice-recent" className="mt-12">
      <h3 id="voice-recent" className="font-display text-lg font-semibold tracking-tight text-ink">
        Recent voice notes
      </h3>
      {notes === null ? (
        <p className="mt-3 text-sm text-ink-faint">Loading…</p>
      ) : notes.length === 0 ? (
        <p data-testid="voice-none" className="mt-3 text-sm text-ink-faint">
          Nothing yet. Your voice notes show up here, and in Meetings.
        </p>
      ) : (
        <ul
          data-testid="voice-notes"
          className="mt-3 divide-y divide-ash/70 rounded-xl border border-ash bg-paper-raised/60"
        >
          {notes.map((note) => {
            const date = note.date ? new Date(note.date) : null
            return (
              <li key={`${note.space}:${note.path}`}>
                <Link
                  to={meetingUrl(note.space, note.path)}
                  className="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-paper-sunk/60"
                >
                  <Icon name="mic" className="size-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {note.title}
                    </span>
                    <span className="block text-xs text-ink-faint">
                      {date && !Number.isNaN(date.getTime())
                        ? `${dayLabel(date)} · ${timeLabel(date)}`
                        : null}
                      {note.duration_min !== null ? ` · ${durationLabel(note.duration_min)}` : null}
                      {note.space === 'team' ? ' · Team' : null}
                    </span>
                  </span>
                  <Icon name="chevron" className="size-4 shrink-0 text-ink-faint" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Words() {
  const [words, setWords] = useState<DictationWords | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || words) return
    dictationApi.words().then(setWords, (err: unknown) => setError(messageOf(err)))
  }, [open, words])
  return (
    <details
      data-testid="voice-words"
      className="mt-10 rounded-xl border border-ash bg-paper-raised/40"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex min-h-12 cursor-pointer items-center justify-between px-4 text-sm font-medium text-ink">
        Words {product()} should spell right
        <Icon name="chevron" className="voice-words-chevron size-4 text-ink-faint" />
      </summary>
      <div className="grid gap-3 px-3 pb-3">
        <p className="px-1 text-xs text-ink-soft">
          Names and terms {product()} should hear and spell exactly as written, in voice notes,
          meetings and dictation.
        </p>
        {error ? (
          <p role="alert" className="px-1 text-xs text-ember-strong">
            {error}
          </p>
        ) : null}
        <WordEditor
          scope="mine"
          title="My words"
          hint="Only you"
          words={words?.mine ?? null}
          onSaved={(list) => setWords((w) => (w ? { ...w, mine: list } : w))}
        />
        <WordEditor
          scope="team"
          title="Team words"
          hint={org() ? `Everyone at ${org()}` : 'Everyone on the team'}
          words={words?.team ?? null}
          onSaved={(list) => setWords((w) => (w ? { ...w, team: list } : w))}
        />
      </div>
    </details>
  )
}

function useTranscript(socket: MeetingSocket): readonly TranscriptSegment[] {
  return useSyncExternalStore(
    (onChange) => socket.on('transcript', onChange),
    () => socket.transcript,
  )
}

export function isVoiceNote(session: Pick<MeetingSession, 'template'>): boolean {
  return session.template === VOICE_NOTE_TEMPLATE
}

function durationLabel(minutes: number): string {
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

function startError(err: unknown): string {
  if (err instanceof CaptureError) {
    return err.reason === 'denied'
      ? `${product()} needs your microphone. Allow it for this site in your browser’s settings, then tap record again.`
      : err.message
  }
  return messageOf(err)
}

function messageOf(err: unknown): string {
  if (err instanceof HearthApiError) return err.message
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}
