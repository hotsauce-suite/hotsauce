import { useEffect, useReducer, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { calendarApi } from '../../api/calendar'
import { HearthApiError } from '../../api/client'
import { meetingsApi } from '../../api/meetings'
import type { CalendarEvent, Track } from '../../api/types'
import { product } from '../../brand/product'
import { Icon, type IconName } from '../../components/Icon'
import { useSession } from '../../state/session'
import {
  audioArrived,
  type Capture,
  CaptureError,
  type CaptureMode,
  captureAudio,
  supportsTabCapture,
} from './audio/capture'
import { extensionVersion } from './audio/extension'
import { framesArrived, supportsMacCapture } from './audio/mac'
import {
  MeetingsPageHeader,
  primaryButton,
  secondaryButton,
  TemplateSelect,
  useTemplates,
} from './components/common'
import { attendeeName, defaultMeetingTitle, startOfDay, timeLabel } from './format'
import { beginLive } from './live/controller'
import { getLive, patchLive, useLive } from './live/liveState'
import { meetCallCode } from './meetEvent'
import {
  type CheckState,
  canStart,
  INITIAL_START,
  overallCheck,
  startReducer,
} from './startMachine'

const consentLine = () =>
  `Heads up: I’m taking notes with ${product()} so I can focus on our conversation. Say if you’d rather I didn’t.`

const TRACK_LABEL: Record<Track, string> = {
  me: 'You, on the microphone',
  them: 'The call, from the Meet tab',
}

/** The event with this id, from yesterday through the next week. */
function eventById(id: string): Promise<CalendarEvent | null> {
  const from = new Date(startOfDay(new Date()).getTime() - 86_400_000)
  const to = new Date(from.getTime() + 9 * 86_400_000)
  return calendarApi
    .upcoming({ from: from.toISOString(), to: to.toISOString() })
    .then((events) => events.find((e) => e.id === id) ?? null)
}

/**
 * The event named by id, or else the one the server matches to the Meet call `meet` (the
 * extension's Take notes).
 */
function useCalendarEvent(id: string | null, meet: string | null): CalendarEvent | null {
  const [event, setEvent] = useState<CalendarEvent | null>(null)
  useEffect(() => {
    if (!id && !meet) return
    let cancelled = false
    const found = id ? eventById(id) : calendarApi.match(meet ?? '').then((m) => m.event)
    found.then(
      (e) => {
        if (!cancelled) setEvent(e)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [id, meet])
  return event
}

/** The Hearth Chrome extension's version when it's installed in this browser. */
function useExtensionVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void extensionVersion().then((v) => {
      if (!cancelled) setVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return version
}

/** /meetings/start?event= — title, template, capture mode, the audio check, and Start. */
export default function StartMeeting() {
  // Only a meeting that was live when the page opened; the one this form starts navigates away.
  const [liveAtOpen] = useState(getLive)
  const live = useLive()
  if (live && live.id === liveAtOpen?.id) {
    return (
      <>
        <MeetingsPageHeader title="New meeting" />
        <div className="mx-auto w-full max-w-xl px-4 py-12">
          <h2 className="font-display text-2xl font-semibold">A meeting is being recorded</h2>
          <p className="mt-2 text-ink-soft">
            Stop “{live.title}” before starting another. Its notes and transcript are safe.
          </p>
          <Link to={`/meetings/live/${live.id}`} className={`${primaryButton} mt-5`}>
            Back to the meeting
          </Link>
        </div>
      </>
    )
  }
  return <StartForm />
}

function StartForm() {
  const navigate = useNavigate()
  const session = useSession()
  const [params] = useSearchParams()
  const eventId = params.get('event')
  // Opened by the extension's "Take notes" on a Meet call.
  const viaExtension = params.get('via') === 'extension'
  const meet = params.get('meet')
  // Opened by the Mac app's "Take notes on this call?": the app that is on the call.
  const callApp = params.get('via') === 'mac-call' ? params.get('app')?.trim().slice(0, 60) : null
  const event = useCalendarEvent(eventId, meet)
  // The Meet call this meeting is for, so the extension hands over that tab and no other.
  const call = meet ?? meetCallCode(event?.meetLink)
  const extension = useExtensionVersion()
  const templates = useTemplates()
  const [title, setTitle] = useState(() => (callApp ? `${callApp} call` : ''))
  const [placeholder] = useState(() => defaultMeetingTitle())
  const [template, setTemplate] = useState('general')
  const [state, dispatch] = useReducer(startReducer, INITIAL_START)
  const capture = useRef<Capture | null>(null)
  const handedOff = useRef(false)
  const tabCapture = supportsTabCapture()
  const macCapture = supportsMacCapture()
  const titleTouched = useRef(false)

  useEffect(() => {
    document.title = `New meeting · ${product()} Meetings`
  }, [])

  // A calendar event names the meeting, unless the person already typed a title.
  useEffect(() => {
    if (event && !titleTouched.current) setTitle(event.title)
  }, [event])

  // Leaving without starting releases the microphone and the tab share.
  const left = useRef(false)
  useEffect(() => {
    left.current = false
    return () => {
      left.current = true
      if (!handedOff.current) capture.current?.stop()
    }
  }, [])
  /** Counts mode choices, so a permission answered late knows a newer choice replaced it. */
  const choices = useRef(0)

  const check = (current: Capture, tracks: Track[]) => {
    for (const track of tracks) {
      const stream = current.streams[track]
      const arrived = current.frames
        ? framesArrived(current.frames, track)
        : stream
          ? audioArrived(stream)
          : null
      if (!arrived) continue
      void arrived.then(
        (arrived) => {
          if (capture.current === current) dispatch({ type: 'checked', track, arrived })
        },
        () => {
          if (capture.current === current) dispatch({ type: 'checked', track, arrived: false })
        },
      )
    }
  }

  // Runs inside the click: Chrome opens the share picker only during a user gesture.
  const choose = async (mode: CaptureMode) => {
    choices.current += 1
    const choice = choices.current
    const replaced = () => left.current || choice !== choices.current
    dispatch({ type: 'choose', mode })
    capture.current?.stop()
    capture.current = null
    try {
      const next = await captureAudio(mode, call)
      // The page was left, or another mode chosen, while the browser asked: let this one go.
      if (replaced()) {
        next.stop()
        return
      }
      capture.current = next
      const tracks = next.frames?.tracks ?? (Object.keys(next.streams) as Track[])
      dispatch({ type: 'granted', tracks })
      check(next, tracks)
    } catch (err) {
      if (replaced()) return
      dispatch({
        type: 'refused',
        message:
          err instanceof CaptureError
            ? err.message
            : `${product()} couldn’t start listening. Try again.`,
      })
    }
  }

  // The member chose "Take notes" on the app's call notice: listen to the Mac at once.
  const autoChose = useRef(false)
  useEffect(() => {
    if (!callApp || !macCapture || autoChose.current) return
    autoChose.current = true
    void choose('mac')
  })

  const recheck = () => {
    const current = capture.current
    if (!current || state.step !== 'check') return
    dispatch({ type: 'recheck' })
    check(
      current,
      (Object.keys(state.tracks) as Track[]).filter((t) => state.tracks[t] !== 'ok'),
    )
  }

  const start = async () => {
    const current = capture.current
    if (!current || !canStart(state)) return
    dispatch({ type: 'start' })
    try {
      const created = await meetingsApi.createSession({
        title: title.trim() || event?.title || placeholder,
        template,
        ...(event ? { calendarEventId: event.id } : {}),
        ...(call ? { meetCode: call } : {}),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      // The capture now belongs to the live meeting; leaving this page must not stop it.
      handedOff.current = true
      const meeting = beginLive(created)
      meeting.attachCapture(current).catch(() => {
        patchLive({
          error: `${product()} couldn’t start recording audio. Resume capture to try again.`,
        })
      })
      navigate(`/meetings/live/${encodeURIComponent(created.id)}`, { replace: true })
    } catch (err) {
      dispatch({
        type: 'failed',
        message:
          err instanceof HearthApiError ? err.message : 'The meeting didn’t start. Try again.',
      })
    }
  }

  const mode = state.step === 'choose' ? null : state.mode
  const tracks =
    state.step === 'check' || state.step === 'starting' || state.step === 'error'
      ? state.tracks
      : null
  const overall: CheckState = tracks ? overallCheck(tracks) : 'waiting'

  return (
    <>
      <MeetingsPageHeader title={event ? 'Take notes' : 'New meeting'} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-32 md:px-6 md:pt-10">
          {event ? (
            <p className="mb-2 text-sm text-ink-soft">
              {timeLabel(new Date(event.start))}–{timeLabel(new Date(event.end))}
              {event.attendees.length > 0
                ? ` · with ${event.attendees
                    .filter((a) => a.email !== session.me?.principal.email)
                    .map((a) => a.name ?? attendeeName(a.email))
                    .join(', ')}`
                : null}
            </p>
          ) : null}
          <input
            data-testid="start-title"
            aria-label="Title"
            value={title}
            placeholder={placeholder}
            onChange={(e) => {
              titleTouched.current = true
              setTitle(e.target.value)
            }}
            className="w-full border-0 bg-transparent p-0 font-display text-[2rem] leading-tight font-semibold tracking-tight text-ink placeholder:text-ink-faint focus-visible:shadow-none md:text-[2.4rem]"
          />
          <div className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
            <span>Template</span>
            <TemplateSelect
              templates={templates}
              value={template}
              onChange={setTemplate}
              testId="start-template"
            />
          </div>

          <h2 className="mt-8 mb-3 text-sm font-semibold text-ink-soft">
            How should {product()} listen?
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {macCapture ? (
              <ModeCard
                testId="capture-mac"
                icon="laptop"
                title="Any app on this Mac"
                body="Zoom, Slack, FaceTime, a browser call, or a phone call on this Mac. It hears your mic and everything the Mac plays."
                selected={mode === 'mac'}
                disabled={state.step === 'starting'}
                onClick={() => void choose('mac')}
              />
            ) : null}
            <ModeCard
              testId="capture-meet-tab"
              icon="tab"
              title="Meet tab + mic"
              body={
                !tabCapture
                  ? 'Sharing a tab’s audio needs Chrome or Edge on a computer.'
                  : extension && viaExtension
                    ? `${product()} listens to the Meet tab you clicked the ${product()} icon on. No share dialog.`
                    : extension
                      ? `For a Google Meet call in this browser. Click the ${product()} icon on the Meet tab first to skip Chrome’s share dialog.`
                      : 'For a Google Meet call in this browser. Chrome asks what to share: pick the Meet tab and tick “Share tab audio”.'
              }
              selected={mode === 'meet-tab'}
              disabled={!tabCapture || state.step === 'starting'}
              onClick={() => void choose('meet-tab')}
            />
            <ModeCard
              testId="capture-mic-only"
              icon="mic"
              title="Mic only"
              body="In person, or a call on speaker. On a phone, keep the screen on while you record."
              selected={mode === 'mic-only'}
              disabled={state.step === 'starting'}
              onClick={() => void choose('mic-only')}
            />
          </div>
          {tabCapture && !extension ? (
            <p className="mt-2 text-sm text-ink-soft">
              <Link to="/meetings/extension" className="text-ember-strong underline">
                Get the Chrome extension
              </Link>{' '}
              to skip the share dialog.
            </p>
          ) : null}

          {mode ? (
            <section
              data-testid="audio-check"
              data-state={state.step === 'blocked' ? 'failed' : overall}
              aria-live="polite"
              className="mt-5 rounded-xl border border-ash bg-paper-raised/60 p-4"
            >
              <h3 className="text-sm font-semibold text-ink">Is sound arriving?</h3>
              {state.step === 'permission' ? (
                <p className="mt-2 text-sm text-ink-soft">
                  {mode === 'mac'
                    ? 'If your Mac asks, allow the microphone and System Audio Recording.'
                    : mode === 'meet-tab' && extension
                      ? 'Connecting to the Meet tab. If Chrome asks what to share, pick the Meet tab and tick “Share tab audio”.'
                      : mode === 'meet-tab'
                        ? 'Pick the Meet tab in Chrome’s window, tick “Share tab audio”, then Share.'
                        : 'Allow the microphone when the browser asks.'}
                </p>
              ) : null}
              {state.step === 'blocked' ? (
                <p className="mt-2 text-sm text-ember-strong">{state.message}</p>
              ) : null}
              {tracks ? (
                <ul className="mt-2 space-y-1.5">
                  {(Object.keys(tracks) as Track[]).sort().map((track) => (
                    <TrackRow key={track} track={track} state={tracks[track] ?? 'waiting'} />
                  ))}
                </ul>
              ) : null}
              {overall === 'failed' && state.step === 'check' ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-ink-soft">
                    {tracks?.them === 'failed' && mode === 'mac'
                      ? `No sound from other apps yet. Someone may just not be talking. If it stays silent during a call, turn on ${product()} in System Settings → Privacy & Security → Screen & System Audio Recording.`
                      : tracks?.them === 'failed'
                        ? 'No sound from the Meet tab yet. Someone may just not be talking.'
                        : `${product()} can’t hear the microphone. Check it isn’t muted.`}
                  </span>
                  <button type="button" onClick={recheck} className="text-ember-strong underline">
                    Check again
                  </button>
                </div>
              ) : null}
              {state.step === 'error' ? (
                <p className="mt-3 text-sm text-ember-strong">{state.message}</p>
              ) : null}
            </section>
          ) : null}

          <aside className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
            <span>Let attendees know you’re taking notes.</span>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(consentLine()).then(
                  () => session.notify('Copied. Paste it into the Meet chat.'),
                  () => {},
                )
              }
              className="text-ember-strong underline"
            >
              Copy a line for the chat
            </button>
          </aside>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-ash/70 bg-paper/90 px-4 py-3 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-3 md:px-2">
          <Link to="/meetings" className={secondaryButton}>
            Cancel
          </Link>
          <button
            type="button"
            data-testid="start-recording"
            disabled={!canStart(state)}
            onClick={() => void start()}
            className={primaryButton}
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-paper-raised" />
            {state.step === 'starting'
              ? 'Starting…'
              : overall === 'failed'
                ? 'Start anyway'
                : 'Start recording'}
          </button>
        </div>
      </div>
    </>
  )
}

function ModeCard({
  testId,
  icon,
  title,
  body,
  selected,
  disabled,
  onClick,
}: {
  testId: string
  icon: IconName
  title: string
  body: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left disabled:cursor-not-allowed disabled:opacity-55 ${
        selected
          ? 'border-ember bg-ember-wash'
          : 'border-ash bg-paper-raised/60 hover:border-ash-strong'
      }`}
    >
      <span className="flex items-center gap-2 font-medium text-ink">
        <Icon name={icon} className="size-4.5 text-ember" />
        {title}
      </span>
      <span className="text-sm leading-snug text-ink-soft">{body}</span>
    </button>
  )
}

const CHECK_TEXT: Record<CheckState, string> = {
  waiting: 'Listening…',
  ok: 'Sound is arriving',
  failed: 'Silent',
}

function TrackRow({ track, state }: { track: Track; state: CheckState }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <span
        aria-hidden="true"
        className={`flex size-5 items-center justify-center rounded-full ${
          state === 'ok'
            ? 'bg-moss-wash text-moss'
            : state === 'failed'
              ? 'bg-ember-wash text-ember-strong'
              : 'bg-ash/50 text-ink-faint'
        }`}
      >
        <Icon
          name={state === 'ok' ? 'check' : state === 'failed' ? 'close' : 'more'}
          className="size-3"
        />
      </span>
      <span className="flex-1 text-ink">{TRACK_LABEL[track]}</span>
      <span className={state === 'failed' ? 'text-ember-strong' : 'text-ink-soft'}>
        {CHECK_TEXT[state]}
      </span>
    </li>
  )
}
