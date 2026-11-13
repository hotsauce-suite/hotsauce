import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Link, useNavigate, useParams } from 'react-router'
import remarkGfm from 'remark-gfm'
import { type Clip, clipsApi, type TranscriptSegment } from '../../api/clips'
import { product } from '../../brand/product'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/TopBar'
import { useShortcut } from '../../keyboard/shortcuts'
import { docUrl, meetingUrl } from '../../lib/paths'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { activeLine, formatDuration, formatTimestamp, formatWhen } from './format'
import { loadSpeed, SPEEDS, saveSpeed, speedLabel, stepSpeed } from './speed'

type Loaded = { clip: Clip; transcript: TranscriptSegment[] }

/** Whether the server is still working on this clip, so the page should look again soon. */
function working(clip: Clip): boolean {
  return (
    clip.status === 'processing' ||
    (clip.status === 'ready' &&
      (clip.transcriptStatus === 'pending' ||
        clip.transcriptStatus === 'processing' ||
        clip.compositeStatus === 'pending' ||
        clip.compositeStatus === 'processing'))
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
      const url = next.clip.videoUrl
      if (url) {
        setVideoSrc((src) => {
          if (!src) return url
          // The camera bubble just went in: switch to that video, unless it's already playing.
          const el = video.current
          const untouched = !el || (el.paused && el.currentTime === 0)
          return next.clip.compositeStatus === 'ready' && !src.includes('composite') && untouched
            ? url
            : src
        })
      }
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
  // Quick while the video or transcript is on its way; slow while only the camera is being
  // added, which can take a long time for a long clip.
  const onlyCompositing =
    clip?.status === 'ready' &&
    clip.transcriptStatus !== 'pending' &&
    clip.transcriptStatus !== 'processing'
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void load(), onlyCompositing ? 15_000 : 2500)
    return () => clearInterval(timer)
  }, [busy, onlyCompositing, load])

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

  // Space or k plays and pauses, ← and → skip 5 s, j and l 10 s, < and > change speed. The key
  // listener leaves Space and the arrows to the video's own controls when they have focus.
  const withVideo = (act: (el: HTMLVideoElement) => void) => () => {
    const el = video.current
    if (!el) return false
    act(el)
    return true
  }
  useShortcut(
    'clips.play',
    withVideo((el) => {
      if (el.paused) void el.play().catch(() => {})
      else el.pause()
    }),
  )
  useShortcut(
    'clips.back5',
    withVideo((el) => seek(el.currentTime - 5)),
  )
  useShortcut(
    'clips.forward5',
    withVideo((el) => seek(el.currentTime + 5)),
  )
  useShortcut(
    'clips.back10',
    withVideo((el) => seek(el.currentTime - 10)),
  )
  useShortcut(
    'clips.forward10',
    withVideo((el) => seek(el.currentTime + 10)),
  )
  useShortcut(
    'clips.faster',
    withVideo((el) => changeSpeed(stepSpeed(el.playbackRate, 1))),
  )
  useShortcut(
    'clips.slower',
    withVideo((el) => changeSpeed(stepSpeed(el.playbackRate, -1))),
  )

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

  const retryCamera = async () => {
    if (!clip) return
    try {
      const updated = await clipsApi.retryCamera(clip.id)
      setData((d) => (d ? { ...d, clip: updated } : d))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t retry the camera')
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

            {clip.status === 'ready' &&
            (clip.compositeStatus === 'pending' || clip.compositeStatus === 'processing') ? (
              <p className="clip-note" data-testid="composite-status">
                <span className="clip-spinner clip-spinner--small" aria-hidden="true" />
                Adding the camera to the video. This is the screen alone until then; it can take a
                few minutes for a long clip.
              </p>
            ) : null}
            {clip.compositeStatus === 'failed' && clip.isOwner ? (
              <p className="clip-note" data-testid="composite-status">
                The camera couldn’t be added to this video, so it’s the screen alone.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void retryCamera()}
                  data-testid="composite-retry"
                >
                  Try again
                </button>
              </p>
            ) : null}
            {videoSrc && clip.compositeStatus === 'ready' && !videoSrc.includes('composite') ? (
              <p className="clip-note">
                The version with your camera is ready.{' '}
                <button
                  type="button"
                  className="underline decoration-ember/50 underline-offset-2 hover:text-ember"
                  onClick={() => setVideoSrc(clip.videoUrl)}
                >
                  Switch to it
                </button>
              </p>
            ) : null}
            {clip.summary ? (
              <p className="clip-summary" data-testid="clip-summary">
                {clip.summary}
              </p>
            ) : null}
            <ClipNotes
              clip={clip}
              onChange={(updated) => setData((d) => (d ? { ...d, clip: updated } : d))}
            />
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
            onRenameSpeaker={async (speaker, name) => {
              try {
                const updated = await clipsApi.setSpeakers(clip.id, { [String(speaker)]: name })
                setData((d) => (d ? { ...d, clip: updated } : d))
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Couldn’t rename the speaker')
              }
            }}
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
  onRenameSpeaker,
}: {
  clip: Clip
  transcript: TranscriptSegment[]
  time: number
  onSeek: (seconds: number) => void
  onRetry: () => void
  onRenameSpeaker: (speaker: number, name: string) => Promise<void>
}) {
  const names = useMemo(() => new Map(clip.speakers.map((s) => [s.id, s.name])), [clip.speakers])
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
      <>
        {clip.speakers.length > 0 ? (
          <Speakers speakers={clip.speakers} canEdit={clip.isOwner} onRename={onRenameSpeaker} />
        ) : null}
        <ol ref={list} className="clip-transcript" data-testid="clip-transcript">
          {transcript.map((line, i) => {
            // The name heads each run of one person's lines.
            const speaker =
              line.speaker !== undefined && line.speaker !== transcript[i - 1]?.speaker
                ? names.get(line.speaker)
                : undefined
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder; two can share a start.
              <li key={`${line.start}-${i}`}>
                {speaker ? (
                  <span className="clip-transcript__speaker" data-testid="transcript-speaker">
                    {speaker}
                  </span>
                ) : null}
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
            )
          })}
        </ol>
      </>
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

/** The clip's speakers; the owner clicks a name to change it on every line. */
function Speakers({
  speakers,
  canEdit,
  onRename,
}: {
  speakers: Clip['speakers']
  canEdit: boolean
  onRename: (speaker: number, name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const save = async (id: number) => {
    setEditing(null)
    const current = speakers.find((s) => s.id === id)
    if (!current || draft.trim() === current.name) return
    await onRename(id, draft)
  }
  return (
    <div className="clip-speakers" data-testid="clip-speakers">
      <span className="text-xs text-ink-faint">Speakers</span>
      {speakers.map((s) =>
        editing === s.id ? (
          <form
            key={s.id}
            onSubmit={(e) => {
              e.preventDefault()
              void save(s.id)
            }}
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: the owner just asked to rename this speaker.
              autoFocus
              value={draft}
              maxLength={60}
              aria-label={`Name for ${s.name}`}
              data-testid={`speaker-input-${s.id}`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void save(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(null)
              }}
              className="clip-speakers__input"
            />
          </form>
        ) : (
          <button
            key={s.id}
            type="button"
            disabled={!canEdit}
            title={canEdit ? 'Rename this speaker on every line' : undefined}
            data-testid={`speaker-${s.id}`}
            className="clip-speakers__chip"
            onClick={() => {
              setDraft(s.named ? s.name : '')
              setEditing(s.id)
            }}
          >
            {s.name}
            {canEdit ? <Icon name="pencil" className="size-3" /> : null}
          </button>
        ),
      )}
    </div>
  )
}

/**
 * Summarize and Action items, by the language model, kept on the clip; then send it all to a
 * new Doc or a Meetings note in your own space.
 */
function ClipNotes({ clip, onChange }: { clip: Clip; onChange: (clip: Clip) => void }) {
  const [busy, setBusy] = useState<'summary' | 'actions' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ href: string; label: string } | null>(null)
  const [withTranscript, setWithTranscript] = useState(true)
  const hasTranscript = clip.transcriptStatus === 'ready'
  if (clip.status !== 'ready') return null

  const generate = async (kind: 'summary' | 'actions') => {
    setBusy(kind)
    setError(null)
    try {
      onChange(await clipsApi.generate(clip.id, kind))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work; try again')
    } finally {
      setBusy(null)
    }
  }

  const send = async (to: 'doc' | 'meeting') => {
    setBusy('send')
    setError(null)
    setSent(null)
    try {
      const { space, path } = await clipsApi.send(clip.id, to, withTranscript)
      setSent(
        to === 'doc'
          ? { href: docUrl(space, path), label: 'Open the doc' }
          : { href: meetingUrl(space, path), label: 'Open the meeting note' },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t write the note')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="clip-notes" aria-label="Notes" data-testid="clip-notes">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={!hasTranscript || busy !== null}
          onClick={() => void generate('summary')}
          data-testid="clip-summarize"
        >
          <Icon name="sparkle" />
          {busy === 'summary' ? 'Summarizing…' : clip.aiSummary ? 'Summarize again' : 'Summarize'}
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={!hasTranscript || busy !== null}
          onClick={() => void generate('actions')}
          data-testid="clip-actions"
        >
          <Icon name="check" />
          {busy === 'actions' ? 'Finding them…' : 'Action items'}
        </button>
        {!hasTranscript ? (
          <span className="text-xs text-ink-faint">These need the transcript.</span>
        ) : null}
      </div>

      {clip.aiSummary ? (
        <div className="clip-notes__block" data-testid="clip-ai-summary">
          <h3>Summary</h3>
          <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>
            {clip.aiSummary}
          </Markdown>
        </div>
      ) : null}
      {clip.aiActions !== null ? (
        <div className="clip-notes__block" data-testid="clip-ai-actions">
          <h3>Action items</h3>
          {clip.aiActions ? (
            <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>
              {clip.aiActions}
            </Markdown>
          ) : (
            <p className="text-sm text-ink-faint">None found in this clip.</p>
          )}
        </div>
      ) : null}

      <div className="clip-notes__send">
        <span className="text-sm text-ink-soft">Send to</span>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={busy !== null}
          onClick={() => void send('doc')}
          data-testid="clip-send-doc"
        >
          <Icon name="docs" />A new doc
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={busy !== null}
          onClick={() => void send('meeting')}
          data-testid="clip-send-meeting"
        >
          <Icon name="calendar" />A meeting note
        </button>
        {hasTranscript ? (
          <label className="flex items-center gap-1.5 text-xs text-ink-faint">
            <input
              type="checkbox"
              checked={withTranscript}
              onChange={(e) => setWithTranscript(e.target.checked)}
              data-testid="clip-send-transcript"
            />
            with the transcript
          </label>
        ) : null}
      </div>
      {sent ? (
        <p className="text-sm text-ink" data-testid="clip-sent">
          Saved in your space.{' '}
          <Link to={sent.href} className="text-ember underline underline-offset-2">
            {sent.label}
          </Link>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-ember">
          {error}
        </p>
      ) : null}
    </section>
  )
}
