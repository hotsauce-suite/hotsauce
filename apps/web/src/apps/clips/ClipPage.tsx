import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { type Clip, clipsApi, type TranscriptSegment } from '../../api/clips'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/TopBar'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { activeLine, formatDuration, formatTimestamp, formatWhen } from './format'
import { loadSpeed, SPEEDS, saveSpeed, speedLabel, stepSpeed } from './speed'

type Loaded = { clip: Clip; transcript: TranscriptSegment[] }

/** Whether the server is still working on this clip, so the page should look again soon. */
function working(clip: Clip): boolean {
  return (
    clip.status === 'processing' ||
    (clip.status === 'ready' &&
      (clip.transcriptStatus === 'pending' || clip.transcriptStatus === 'processing'))
  )
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
}

/** `/clips/:id`: the video with speed control, its transcript, and the owner's actions. */
export default function ClipPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The first URL is kept: a later poll signs a new one, and swapping it would restart playback.
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [speed, setSpeed] = useState(loadSpeed)
  const [time, setTime] = useState(0)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const video = useRef<HTMLVideoElement>(null)

  const load = useCallback(async () => {
    try {
      const next = await clipsApi.get(id)
      setData(next)
      setError(null)
      if (next.clip.videoUrl) setVideoSrc((src) => src ?? next.clip.videoUrl)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t load this clip')
      return null
    }
  }, [id])

  useEffect(() => {
    setData(null)
    setVideoSrc(null)
    void load()
  }, [load])

  const clip = data?.clip ?? null
  const busy = clip ? working(clip) : false
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void load(), 2500)
    return () => clearInterval(timer)
  }, [busy, load])

  useEffect(() => {
    document.title = clip ? `${clip.title} · ${product()} Clips` : `${product()} Clips`
  }, [clip])

  // The remembered speed; a newly loaded source gets it in onLoadedMetadata.
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed
  }, [speed])

  const changeSpeed = useCallback((next: number) => {
    setSpeed(next)
    saveSpeed(next)
  }, [])

  const seek = useCallback((seconds: number, play = false) => {
    const el = video.current
    if (!el) return
    el.currentTime = Math.max(0, seconds)
    setTime(el.currentTime)
    if (play) void el.play().catch(() => {})
  }, [])

  // Space or k plays and pauses, ← and → skip 5 s, j and l 10 s, < and > change speed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = video.current
      if (!el || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key
      if (key === ' ' || key === 'k') {
        // The video's own controls handle Space when they have focus.
        if (key === ' ' && event.target === el) return
        event.preventDefault()
        if (el.paused) void el.play().catch(() => {})
        else el.pause()
      } else if (key === 'ArrowLeft' || key === 'j') {
        if (event.target === el) return
        event.preventDefault()
        seek(el.currentTime - (key === 'j' ? 10 : 5))
      } else if (key === 'ArrowRight' || key === 'l') {
        if (event.target === el) return
        event.preventDefault()
        seek(el.currentTime + (key === 'l' ? 10 : 5))
      } else if (key === '>' || key === '<') {
        event.preventDefault()
        changeSpeed(stepSpeed(el.playbackRate, key === '>' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seek, changeSpeed])

  const copyLink = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/clips/${id}`).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const rename = async (title: string) => {
    if (!clip) return
    setEditing(false)
    const trimmed = title.trim()
    if (!trimmed || trimmed === clip.title) return
    setData((d) => (d ? { ...d, clip: { ...d.clip, title: trimmed } } : d))
    try {
      const updated = await clipsApi.rename(clip.id, trimmed)
      setData((d) => (d ? { ...d, clip: updated } : d))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t rename the clip')
      void load()
    }
  }

  const remove = async () => {
    if (!clip) return
    try {
      await clipsApi.remove(clip.id)
      navigate('/clips', { replace: true })
    } catch (err) {
      setConfirmDelete(false)
      setError(err instanceof Error ? err.message : 'Couldn’t delete the clip')
    }
  }

  const retryTranscript = async () => {
    if (!clip) return
    try {
      const updated = await clipsApi.retryTranscript(clip.id)
      setData((d) => (d ? { ...d, clip: updated } : d))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t retry the transcript')
    }
  }

  if (!clip) {
    return (
      <>
        <MeetingsPageHeader title={`${product()} Clips`} />
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-ink-faint">
          {error ? (
            <div className="text-center">
              <p className="text-ink">{error}</p>
              <Link to="/clips" className={`${secondaryButton} mt-4`}>
                Back to clips
              </Link>
            </div>
          ) : (
            'Loading…'
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <MeetingsPageHeader
        title={
          editing ? (
            <TitleEditor initial={clip.title} onDone={rename} />
          ) : (
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate" data-testid="clip-title">
                {clip.title}
              </span>
              {clip.isOwner ? (
                <button
                  type="button"
                  aria-label="Rename"
                  title="Rename"
                  data-testid="clip-rename"
                  onClick={() => setEditing(true)}
                  className="rounded p-1 text-ink-faint hover:bg-paper-sunk hover:text-ink"
                >
                  <Icon name="pencil" className="size-3.5" />
                </button>
              ) : null}
            </span>
          )
        }
      >
        <button
          type="button"
          onClick={() => void copyLink()}
          data-testid="clip-copy-link"
          className={`${secondaryButton} h-8 px-3`}
        >
          <Icon name={copied ? 'check' : 'link'} />
          <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy link'}</span>
        </button>
        {clip.downloadUrl ? (
          <a
            href={clip.downloadUrl}
            download
            aria-label="Download"
            title="Download"
            data-testid="clip-download"
            className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
          >
            <Icon name="download" className="size-4" />
          </a>
        ) : null}
        {clip.isOwner ? (
          <IconButton
            icon="trash"
            label="Delete clip"
            testId="clip-delete"
            onClick={() => setConfirmDelete(true)}
          />
        ) : null}
      </MeetingsPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden" data-testid="clip-page">
        <div className="clip-layout">
          <div className="clip-main">
            <div className="clip-stage">
              {clip.status === 'ready' && videoSrc ? (
                // biome-ignore lint/a11y/useMediaCaption: the transcript beside it is the text alternative.
                <video
                  ref={video}
                  src={videoSrc}
                  controls
                  playsInline
                  preload="metadata"
                  data-testid="clip-video"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.playbackRate = speed
                  }}
                  onRateChange={(e) => {
                    const rate = e.currentTarget.playbackRate
                    if ((SPEEDS as readonly number[]).includes(rate) && rate !== speed) {
                      changeSpeed(rate)
                    }
                  }}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                />
              ) : (
                <div className="clip-stage__placeholder" data-testid="clip-processing">
                  {clip.status === 'failed' ? (
                    <>
                      <p className="font-medium text-ink">{clip.error}</p>
                      <p className="mt-1 text-sm text-ink-faint">
                        The recording didn’t make it. Record it again?
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="clip-spinner" aria-hidden="true" />
                      <p className="mt-3 text-ink">Getting your video ready…</p>
                      <p className="mt-1 text-sm text-ink-faint">
                        It’s usually a few seconds. You can copy the link now.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <fieldset className="clip-speeds" aria-label="Playback speed">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={s === speed}
                    data-testid={`clip-speed-${s}`}
                    onClick={() => changeSpeed(s)}
                  >
                    {speedLabel(s)}
                  </button>
                ))}
              </fieldset>
              <p className="text-xs text-ink-faint" data-testid="clip-meta">
                {clip.owner.name} · {formatWhen(clip.createdAt)}
                {clip.durationMs ? ` · ${formatDuration(clip.durationMs)}` : ''}
              </p>
            </div>

            {clip.summary ? (
              <p className="clip-summary" data-testid="clip-summary">
                {clip.summary}
              </p>
            ) : null}
            <p className="mt-4 hidden text-xs text-ink-faint lg:block">
              <Kbd>Space</Kbd> play or pause · <Kbd>←</Kbd> <Kbd>→</Kbd> 5 s · <Kbd>&lt;</Kbd>{' '}
              <Kbd>&gt;</Kbd> speed
            </p>
            {error ? (
              <p role="alert" className="mt-3 text-sm text-ember">
                {error}
              </p>
            ) : null}
          </div>

          <TranscriptPanel
            clip={clip}
            transcript={data?.transcript ?? []}
            time={time}
            onSeek={(s) => seek(s, true)}
            onRetry={() => void retryTranscript()}
          />
        </div>
      </div>

      {confirmDelete ? (
        <Dialog
          title="Delete this clip?"
          onClose={() => setConfirmDelete(false)}
          testId="clip-delete-dialog"
        >
          <p className="text-sm text-ink-soft">
            The video and its transcript are deleted for everyone with the link. This can’t be
            undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setConfirmDelete(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className={primaryButton}
              data-testid="clip-delete-confirm"
              onClick={() => void remove()}
            >
              Delete
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-ash bg-paper-raised px-1 font-mono text-[0.7rem] text-ink-soft">
      {children}
    </kbd>
  )
}

function TitleEditor({ initial, onDone }: { initial: string; onDone: (title: string) => void }) {
  const [value, setValue] = useState(initial)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onDone(value)
  }
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1">
      <input
        // biome-ignore lint/a11y/noAutofocus: the member just asked to rename it.
        autoFocus
        value={value}
        maxLength={200}
        aria-label="Clip title"
        data-testid="clip-title-input"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onDone(value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone(initial)
        }}
        className="h-8 w-full min-w-0 rounded-md border border-ember/60 bg-paper-raised px-2 font-display text-lg font-semibold tracking-tight text-ink focus:outline-none"
      />
    </form>
  )
}

function TranscriptPanel({
  clip,
  transcript,
  time,
  onSeek,
  onRetry,
}: {
  clip: Clip
  transcript: TranscriptSegment[]
  time: number
  onSeek: (seconds: number) => void
  onRetry: () => void
}) {
  const starts = useMemo(() => transcript.map((s) => s.start), [transcript])
  const active = activeLine(starts, time)
  const list = useRef<HTMLOListElement>(null)

  // Keep the playing line in view, inside the panel only (never scroll the page).
  useEffect(() => {
    const ol = list.current
    const li = ol?.children[active] as HTMLElement | undefined
    if (!ol || !li) return
    const top = li.offsetTop - ol.offsetTop
    if (top < ol.scrollTop || top + li.offsetHeight > ol.scrollTop + ol.clientHeight) {
      ol.scrollTo({ top: top - ol.clientHeight / 3, behavior: 'smooth' })
    }
  }, [active])

  let body: React.ReactNode
  if (
    clip.status !== 'ready' ||
    clip.transcriptStatus === 'pending' ||
    clip.transcriptStatus === 'processing'
  ) {
    body = (
      <p className="clip-pulse px-4 py-6 text-sm text-ink-faint" data-testid="transcript-status">
        {clip.status === 'failed' ? 'No transcript.' : 'Transcribing…'}
      </p>
    )
  } else if (clip.transcriptStatus === 'failed') {
    body = (
      <div className="px-4 py-6 text-sm" data-testid="transcript-status">
        <p className="text-ink">{clip.transcriptError ?? 'The transcript couldn’t be made.'}</p>
        {clip.isOwner ? (
          <button
            type="button"
            className={`${secondaryButton} mt-3 h-8`}
            onClick={onRetry}
            data-testid="transcript-retry"
          >
            Try again
          </button>
        ) : null}
      </div>
    )
  } else if (clip.transcriptStatus === 'none' || transcript.length === 0) {
    body = (
      <p className="px-4 py-6 text-sm text-ink-faint" data-testid="transcript-status">
        {clip.transcriptStatus === 'none'
          ? 'This clip has no sound.'
          : 'No one speaks in this clip.'}
      </p>
    )
  } else {
    body = (
      <ol ref={list} className="clip-transcript" data-testid="clip-transcript">
        {transcript.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder; two can share a start.
          <li key={`${line.start}-${i}`}>
            <button
              type="button"
              aria-current={i === active ? 'true' : undefined}
              data-testid="transcript-line"
              data-start={line.start}
              onClick={() => onSeek(line.start)}
            >
              <span className="clip-transcript__time">{formatTimestamp(line.start)}</span>
              <span>{line.text}</span>
            </button>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <aside className="clip-side" aria-label="Transcript">
      <h2 className="flex items-center gap-2 border-b border-ash/70 px-4 py-3 text-sm font-semibold text-ink">
        <Icon name="transcript" className="size-4 text-ink-faint" />
        Transcript
      </h2>
      {body}
    </aside>
  )
}
