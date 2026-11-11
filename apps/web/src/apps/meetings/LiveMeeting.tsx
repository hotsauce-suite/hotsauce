import type { Text } from '@codemirror/state'
import { placeholder } from '@codemirror/view'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { calendarApi } from '../../api/calendar'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import type { CalendarEvent, MeetingSession, TranscriptSegment } from '../../api/types'
import { product } from '../../brand/product'
import { useShell } from '../../components/AppShell'
import { Icon } from '../../components/Icon'
import { MarkdownEditor } from '../../components/MarkdownEditor'
import { IconButton } from '../../components/TopBar'
import { MOBILE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { isExternalHref, meetingUrl, openExternal } from '../../lib/paths'
import { useSession } from '../../state/session'
import { CaptureError, type CaptureMode, captureAudio, supportsTabCapture } from './audio/capture'
import type { MeetingSocket } from './audio/socket'
import { primaryButton, secondaryButton } from './components/common'
import { LiveTranscript } from './components/LiveTranscript'
import { RecordingIndicator } from './components/RecordingIndicator'
import { attendeeName, timeLabel } from './format'
import { beginLive, currentLive, type LiveMeeting as Meeting, stopSession } from './live/controller'
import { type LiveSnapshot, patchLive, useLive } from './live/liveState'
import { meetCallCode } from './meetEvent'

/** /meetings/live/:id — the notepad while Hearth listens. */
export default function LiveMeeting() {
  const { id = '' } = useParams()
  return <LivePage key={id} id={id} />
}

function useTranscript(socket: MeetingSocket): readonly TranscriptSegment[] {
  return useSyncExternalStore(
    (onChange) => {
      const off = socket.on('transcript', onChange)
      return () => {
        off()
      }
    },
    () => socket.transcript,
  )
}

function LivePage({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<Meeting | null>(() => {
    const current = currentLive()
    return current?.session.id === id ? current : null
  })
  const [problem, setProblem] = useState<string | null>(null)
  /** Stopped on the server but never saved: the save failed, or the tab died mid-save. */
  const [unsaved, setUnsaved] = useState<MeetingSession | null>(null)
  const live = useLive()
  // Stop clears the live state a moment before the page navigates to the note; keep the last
  // view on screen meanwhile rather than flashing a skeleton.
  const lastLive = useRef<LiveSnapshot | null>(null)
  if (live?.id === id) lastLive.current = live
  const shown = live?.id === id ? live : lastLive.current

  // Opened by a reload or a link: reattach to the session the server still holds.
  useEffect(() => {
    if (meeting) return
    let cancelled = false
    meetingsApi.session(id).then(
      (session) => {
        if (cancelled) return
        if (session.state === 'recording' || session.state === 'paused')
          setMeeting(beginLive(session))
        else if (session.state === 'stopped') setUnsaved(session)
        else setProblem('This meeting has ended. Its notes are with your other meetings.')
      },
      (err: unknown) => {
        if (cancelled) return
        const status = err instanceof HearthApiError ? err.status : 0
        setProblem(
          status === 404
            ? 'There’s no meeting here. It may have ended on another device.'
            : status === 403
              ? 'This meeting belongs to another member. Only the person who started it can open it.'
              : 'This meeting didn’t load. Check your connection and reload.',
        )
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, meeting])

  // Ended by the server while open here: the capture is released; the typed notes stay
  // on screen to copy, in case the other device's copy lacks the last of them.
  const ended = meeting?.endedElsewhere ?? problem
  if (ended) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-16">
        <h1 className="font-display text-2xl font-semibold">{ended}</h1>
        {meeting?.endedElsewhere && meeting.notesText.trim() ? (
          <>
            <p className="mt-4 text-sm text-ink-soft">What you typed on this page:</p>
            <textarea
              readOnly
              value={meeting.notesText}
              aria-label="Notes typed on this page"
              className="mt-2 h-40 w-full rounded-lg border border-ash bg-paper-raised p-3 font-mono text-sm text-ink"
            />
          </>
        ) : null}
        <Link to="/meetings" className={`${primaryButton} mt-5`}>
          All meetings
        </Link>
      </div>
    )
  }
  if (unsaved) return <SaveUnsaved session={unsaved} />
  if (!meeting || !shown) return <LiveSkeleton />
  return <LiveView meeting={meeting} live={shown} />
}

function SaveUnsaved({ session }: { session: MeetingSession }) {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await stopSession(session.id)
      navigate(meetingUrl(saved.space, saved.path), { replace: true, state: { enhance: true } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The meeting didn’t save. Try again.')
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16">
      <h1 className="font-display text-2xl font-semibold">
        This meeting stopped before its notes were saved.
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        {product()} still has the notes and the transcript. Save them to open the note.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className={primaryButton}
        >
          {saving ? 'Saving…' : 'Save it now'}
        </button>
        <Link to="/meetings" className={secondaryButton}>
          All meetings
        </Link>
      </div>
    </div>
  )
}

function LiveSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-1 flex-col">
      <div className="h-[var(--topbar-height)] shrink-0 border-b border-ash/70" />
      <div className="mx-auto w-full max-w-[var(--measure)] px-6 pt-8">
        <div className="h-3.5 w-1/2 rounded-full bg-ash/40" />
      </div>
    </div>
  )
}

function LiveView({ meeting, live }: { meeting: Meeting; live: LiveSnapshot }) {
  const navigate = useNavigate()
  const shell = useShell()
  const session = useSession()
  const wide = !useMediaQuery(MOBILE_QUERY)
  const segments = useTranscript(meeting.socket)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  // null until the server says whether audio can be kept; then the member's choice.
  const [keepAudio, setKeepAudio] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    meetingsApi.settings().then(
      ({ keepAudio }) =>
        live && keepAudio.available && setKeepAudio(meeting.keepAudio ?? keepAudio.byDefault),
      () => {},
    )
    return () => {
      live = false
    }
  }, [meeting])
  const chooseKeepAudio = (keep: boolean) => {
    setKeepAudio(keep)
    meeting.setKeepAudio(keep)
  }
  const [initialNotes] = useState(() => meeting.notesText)
  const event = useSessionEvent(meeting.session.calendarEventId, meeting.session.startedAt)

  const onChange = useCallback((text: Text) => meeting.setNotes(text.toString()), [meeting])
  const { notify } = session
  const notepadExtensions = useMemo(
    () => [placeholder(`Type notes. ${product()} is listening…`)],
    [],
  )

  const stop = async () => {
    setStopping(true)
    setStopError(null)
    try {
      const saved = await meeting.stop(keepAudio === null ? {} : { keepAudio })
      navigate(meetingUrl(saved.space, saved.path), { replace: true, state: { enhance: true } })
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'The meeting didn’t stop. Try again.')
      setStopping(false)
    }
  }

  // Holds here at once; the server catches up when it can.
  const togglePause = () => void (live.state === 'paused' ? meeting.resume() : meeting.pause())

  const resumeCapture = async (mode: CaptureMode) => {
    try {
      const call = meeting.session.meetCode ?? meetCallCode(event?.meetLink)
      await meeting.attachCapture(await captureAudio(mode, call))
    } catch (err) {
      patchLive({
        error:
          err instanceof CaptureError
            ? err.message
            : `${product()} couldn’t start recording audio.`,
      })
    }
  }

  const ended = live.state === 'saved' || live.state === 'stopped'

  return (
    <>
      <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2 border-b border-ash/70 bg-paper/80 px-2 backdrop-blur-sm md:px-4">
        {shell.compact ? (
          <IconButton icon="menu" label="Open sidebar" onClick={shell.openDrawer} />
        ) : null}
        <RecordingIndicator live={live} variant="inline" />
        <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold tracking-tight">
          {live.title}
        </h1>
        {live.link === 'reconnecting' ? (
          <span role="status" className="hidden text-xs text-ink-faint sm:inline">
            Reconnecting… audio is kept on this device
          </span>
        ) : null}
        {live.state === 'paused' ? (
          <button
            type="button"
            data-testid="resume"
            onClick={togglePause}
            disabled={stopping || ended}
            className={`${secondaryButton} h-9 px-3`}
          >
            <Icon name="play" />
            <span className="hidden sm:inline">Resume</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="pause"
            onClick={togglePause}
            disabled={stopping || ended}
            className={`${secondaryButton} h-9 px-3`}
          >
            <Icon name="pause" />
            <span className="hidden sm:inline">Pause</span>
          </button>
        )}
        {keepAudio !== null ? (
          <label
            className="flex items-center gap-1.5 text-sm text-ink-soft"
            title={`Keeps a recording of this meeting in ${product()}'s storage, never in Git. Otherwise the audio is deleted once the transcript is saved.`}
          >
            <input
              type="checkbox"
              data-testid="keep-audio"
              checked={keepAudio}
              disabled={stopping || ended}
              onChange={(e) => chooseKeepAudio(e.target.checked)}
            />
            Keep audio
          </label>
        ) : null}
        <button
          type="button"
          data-testid="stop"
          onClick={() => void stop()}
          disabled={stopping || ended}
          className={`${primaryButton} h-9 px-3`}
        >
          <Icon name="stop" />
          {stopping ? 'Saving…' : 'Stop'}
        </button>
      </header>

      {event ? <EventContext event={event} me={session.me?.principal.email ?? null} /> : null}

      {!live.capturing && !ended ? (
        <Banner>
          <span className="flex-1">
            {live.state === 'paused'
              ? 'Paused, and this page isn’t capturing audio.'
              : 'This page isn’t capturing audio. Your notes and the transcript so far are safe.'}
          </span>
          {supportsTabCapture() ? (
            <button
              type="button"
              onClick={() => void resumeCapture('meet-tab')}
              className="underline"
            >
              Meet tab + mic
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void resumeCapture('mic-only')}
            className="underline"
          >
            Mic only
          </button>
        </Banner>
      ) : null}
      {live.lostTrack === 'them' && live.capturing ? (
        <Banner>
          <span className="flex-1">
            The Meet tab stopped sharing. {product()} is still hearing your microphone.
          </span>
          <button
            type="button"
            onClick={() => void resumeCapture('meet-tab')}
            className="underline"
          >
            Share the tab again
          </button>
        </Banner>
      ) : null}
      {stopError ? (
        <Banner>
          <span className="flex-1">{stopError}</span>
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="underline"
          >
            Try again
          </button>
        </Banner>
      ) : live.error ? (
        <Banner>
          <span className="flex-1">{live.error}</span>
        </Banner>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div data-testid="live-notepad" className="relative min-h-0 flex-1">
            <MarkdownEditor
              compact
              autoFocus
              initialText={initialNotes}
              path="notes.md"
              readOnly={stopping || ended}
              extensions={notepadExtensions}
              onChange={onChange}
              onReady={() => {}}
              upload={() => Promise.reject(new Error('Add images to the note after the meeting.'))}
              findTargets={async () => []}
              onError={notify}
              openLink={(href) => {
                if (isExternalHref(href) && !openExternal(href)) {
                  notify(`This link can’t be opened from ${product()}: ${href}`)
                }
              }}
            />
          </div>
          {transcriptOpen && wide ? null : (
            <LiveTranscript
              segments={segments}
              expanded={transcriptOpen}
              onToggle={() => setTranscriptOpen((open) => !open)}
            />
          )}
        </div>
        {transcriptOpen && wide ? (
          <LiveTranscript segments={segments} expanded onToggle={() => setTranscriptOpen(false)} />
        ) : null}
      </div>
    </>
  )
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ember/25 bg-ember-wash px-4 py-2 text-sm text-ink"
    >
      {children}
    </div>
  )
}

function useSessionEvent(eventId: string | undefined, startedAt: string): CalendarEvent | null {
  const [event, setEvent] = useState<CalendarEvent | null>(null)
  useEffect(() => {
    if (!eventId) return
    let cancelled = false
    const around = Date.parse(startedAt)
    calendarApi
      .upcoming({
        from: new Date(around - 12 * 3_600_000).toISOString(),
        to: new Date(around + 12 * 3_600_000).toISOString(),
      })
      .then(
        (events) => {
          if (!cancelled) setEvent(events.find((e) => e.id === eventId) ?? null)
        },
        () => {},
      )
    return () => {
      cancelled = true
    }
  }, [eventId, startedAt])
  return event
}

/** The calendar event, collapsed to one line until opened (PRD §6.3). */
function EventContext({ event, me }: { event: CalendarEvent; me: string | null }) {
  const others = event.attendees.filter((a) => a.email !== me)
  return (
    <details className="group shrink-0 border-b border-ash/70 bg-paper-raised/40 px-4 text-sm">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 text-ink-soft">
        <Icon name="calendar" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {timeLabel(new Date(event.start))}–{timeLabel(new Date(event.end))}
          {others.length > 0
            ? ` · ${others.map((a) => a.name ?? attendeeName(a.email)).join(', ')}`
            : ''}
        </span>
        <Icon name="chevron" className="size-3 shrink-0 group-open:rotate-90" />
      </summary>
      <div className="space-y-1.5 pb-3 pl-5.5 text-ink-soft">
        <p>
          {event.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')}
        </p>
        {event.description ? (
          <p className="whitespace-pre-wrap text-ink">{event.description}</p>
        ) : null}
        {event.meetLink ? (
          <a
            href={event.meetLink}
            target="_blank"
            rel="noreferrer"
            className="text-ember-strong underline"
          >
            Open the Meet call
          </a>
        ) : null}
      </div>
    </details>
  )
}
