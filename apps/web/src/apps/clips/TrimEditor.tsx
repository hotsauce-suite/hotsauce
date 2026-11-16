import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Clip, ClipCut } from '../../api/clips'
import { Icon } from '../../components/Icon'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import {
  cutAt,
  keptMs,
  MAX_CUTS,
  middleCuts,
  normalizeCuts,
  trimEnd,
  trimStart,
  withTrim,
} from './cuts'
import { formatDuration } from './format'

/** A drag shorter than this on the timeline is a click: it moves the playhead. */
const CLICK_PX = 4
const THUMBS = 10

type Drag =
  | { kind: 'start' | 'end' }
  | { kind: 'select'; fromMs: number; fromX: number; moved: boolean }

/**
 * The owner's trim (`/clips/:id`, Trim): the whole recording on a timeline. Drag the handles to
 * cut the start and the end; drag across the timeline to select a part and cut it out. Play
 * previews the result, skipping what's cut. Nothing changes for viewers until Save.
 */
export function TrimEditor({
  clip,
  onSave,
  onRevert,
  onClose,
}: {
  clip: Clip
  onSave: (cuts: ClipCut[]) => Promise<void>
  onRevert: () => Promise<void>
  onClose: () => void
}) {
  const duration = clip.sourceDurationMs ?? clip.durationMs ?? 0
  const [cuts, setCuts] = useState<ClipCut[]>(() => normalizeCuts(clip.cuts, duration))
  const [history, setHistory] = useState<ClipCut[][]>([])
  const [selection, setSelection] = useState<ClipCut | null>(null)
  const [timeMs, setTimeMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const cutsRef = useRef(cuts)
  cutsRef.current = cuts

  const start = trimStart(cuts)
  const end = trimEnd(cuts, duration)
  const length = keptMs(cuts, duration)
  const changed = JSON.stringify(cuts) !== JSON.stringify(normalizeCuts(clip.cuts, duration))

  const change = useCallback((next: ClipCut[]) => {
    setHistory((h) => [...h.slice(-49), cutsRef.current])
    setCuts(next)
  }, [])

  const seekMs = useCallback(
    (ms: number) => {
      const el = video.current
      const at = Math.max(0, Math.min(duration, ms))
      if (el) el.currentTime = at / 1000
      setTimeMs(at)
    },
    [duration],
  )

  // While playing: skip over what's cut, so play shows the trimmed clip. Checked every frame,
  // since timeupdate fires only a few times a second.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const el = video.current
      if (el) {
        const ms = el.currentTime * 1000
        const cut = cutAt(cutsRef.current, ms)
        if (cut) {
          if (cut.endMs >= duration) {
            el.pause()
            el.currentTime = Math.max(0, trimEnd(cutsRef.current, duration) / 1000 - 0.01)
          } else {
            el.currentTime = cut.endMs / 1000
          }
        }
        setTimeMs(el.currentTime * 1000)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration])

  const togglePlay = () => {
    const el = video.current
    if (!el) return
    if (!el.paused) {
      el.pause()
      return
    }
    // From the start of what's kept when the playhead sits in a cut or at the end.
    const ms = el.currentTime * 1000
    if (cutAt(cuts, ms) || ms >= end - 50) el.currentTime = start / 1000
    void el.play().catch(() => {})
  }

  const msAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(f * duration)
  }

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-trim-handle], [data-cut-restore]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind: 'select', fromMs: msAt(e.clientX), fromX: e.clientX, moved: false }
  }

  const onHandleDown = (kind: 'start' | 'end') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    track.current?.setPointerCapture(e.pointerId)
    setHistory((h) => [...h.slice(-49), cutsRef.current])
    drag.current = { kind }
  }

  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const ms = msAt(e.clientX)
    if (d.kind === 'select') {
      if (!d.moved && Math.abs(e.clientX - d.fromX) < CLICK_PX) return
      d.moved = true
      setSelection({ startMs: Math.min(d.fromMs, ms), endMs: Math.max(d.fromMs, ms) })
      return
    }
    const current = cutsRef.current
    const next =
      d.kind === 'start'
        ? withTrim(current, duration, ms, trimEnd(current, duration))
        : withTrim(current, duration, trimStart(current), ms)
    setCuts(next)
    seekMs(d.kind === 'start' ? trimStart(next) : trimEnd(next, duration))
  }

  const onTrackUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'select' && !d.moved) {
      setSelection(null)
      seekMs(msAt(e.clientX))
    }
  }

  const cutSelection = () => {
    if (!selection) return
    const next = normalizeCuts([...cuts, selection], duration)
    if (keptMs(next, duration) < 1000) {
      setError('Keep at least a second of the clip.')
      return
    }
    if (next.length > MAX_CUTS) {
      setError(`A clip can have at most ${MAX_CUTS} cuts.`)
      return
    }
    setError(null)
    change(next)
    setSelection(null)
  }

  const restoreCut = (cut: ClipCut) => {
    change(cuts.filter((c) => c !== cut))
  }

  const undo = () => {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((h) => h.slice(0, -1))
    setCuts(previous)
  }

  const nudge = (kind: 'start' | 'end', deltaMs: number) => {
    const next =
      kind === 'start'
        ? withTrim(cuts, duration, start + deltaMs, end)
        : withTrim(cuts, duration, start, end + deltaMs)
    change(next)
    seekMs(kind === 'start' ? trimStart(next) : trimEnd(next, duration))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(cuts)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the trim')
      setSaving(false)
    }
  }

  const revert = async () => {
    setSaving(true)
    setError(null)
    try {
      await onRevert()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t restore the original')
      setSaving(false)
    }
  }

  const pct = (ms: number) => `${duration > 0 ? (ms / duration) * 100 : 0}%`
  const middle = middleCuts(cuts, duration)
  const thumbs = useThumbnails(clip.sourceUrl, duration)

  return (
    <section className="clip-trim" data-testid="clip-trim-editor" aria-label="Trim this clip">
      <div className="clip-stage">
        {/* biome-ignore lint/a11y/useMediaCaption: the transcript beside it is the text alternative. */}
        <video
          ref={video}
          src={clip.sourceUrl ?? undefined}
          playsInline
          preload="auto"
          data-testid="trim-video"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onSeeked={(e) => setTimeMs(e.currentTarget.currentTime * 1000)}
          onClick={togglePlay}
        />
      </div>

      <div className="clip-trim__bar">
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={togglePlay}
          data-testid="trim-play"
        >
          <Icon name={playing ? 'pause' : 'play'} />
          {playing ? 'Pause' : 'Preview'}
        </button>
        <span className="font-mono text-xs text-ink-soft" data-testid="trim-time">
          {formatDuration(timeMs)} / {formatDuration(duration)}
        </span>
        <span className="text-xs text-ink-faint">
          New length{' '}
          <strong className="font-mono text-ink" data-testid="trim-length">
            {formatDuration(length)}
          </strong>
        </span>
      </div>

      <div
        ref={track}
        className="clip-trim__track"
        data-testid="trim-track"
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <div className="clip-trim__thumbs" aria-hidden="true" data-testid="trim-thumbs">
          {Array.from({ length: THUMBS }, (_, i) => (
            <canvas
              // biome-ignore lint/suspicious/noArrayIndexKey: one per slot, never reordered.
              key={i}
              ref={(node) => {
                thumbs.current[i] = node
              }}
            />
          ))}
        </div>
        {start > 0 ? (
          <div className="clip-trim__cut" style={{ left: 0, width: pct(start) }} />
        ) : null}
        {end < duration ? (
          <div className="clip-trim__cut" style={{ left: pct(end), right: 0 }} />
        ) : null}
        {middle.map((cut) => (
          <div
            key={`${cut.startMs}-${cut.endMs}`}
            className="clip-trim__cut"
            data-testid="trim-cut"
            style={{ left: pct(cut.startMs), width: pct(cut.endMs - cut.startMs) }}
          >
            <button
              type="button"
              data-cut-restore
              className="clip-trim__restore"
              aria-label={`Put back ${formatDuration(cut.startMs)} to ${formatDuration(cut.endMs)}`}
              title="Put this part back"
              onClick={() => restoreCut(cut)}
            >
              <Icon name="close" className="size-3" />
            </button>
          </div>
        ))}
        {selection ? (
          <div
            className="clip-trim__selection"
            data-testid="trim-selection"
            style={{
              left: pct(selection.startMs),
              width: pct(selection.endMs - selection.startMs),
            }}
          />
        ) : null}
        <div className="clip-trim__playhead" style={{ left: pct(timeMs) }} />
        {(['start', 'end'] as const).map((kind) => {
          const at = kind === 'start' ? start : end
          return (
            <button
              key={kind}
              type="button"
              role="slider"
              data-trim-handle
              data-testid={`trim-handle-${kind}`}
              aria-label={kind === 'start' ? 'Start of the clip' : 'End of the clip'}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration / 1000)}
              aria-valuenow={Math.round(at / 1000)}
              aria-valuetext={formatDuration(at)}
              className={`clip-trim__handle clip-trim__handle--${kind}`}
              style={{ left: pct(at) }}
              onPointerDown={onHandleDown(kind)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 1000 : 100
                if (e.key === 'ArrowLeft') nudge(kind, -step)
                else if (e.key === 'ArrowRight') nudge(kind, step)
                else return
                e.preventDefault()
              }}
            />
          )
        })}
      </div>

      <div className="clip-trim__actions">
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={() => change(withTrim(cuts, duration, timeMs, end))}
          data-testid="trim-start-here"
        >
          Start here
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          onClick={() => change(withTrim(cuts, duration, start, timeMs))}
          data-testid="trim-end-here"
        >
          End here
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={!selection}
          onClick={cutSelection}
          data-testid="trim-cut-selection"
        >
          <Icon name="scissors" />
          {selection ? `Cut ${formatDuration(selection.endMs - selection.startMs)}` : 'Cut a part'}
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-8 px-3`}
          disabled={history.length === 0}
          onClick={undo}
          data-testid="trim-undo"
        >
          Undo
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        Drag the ends to trim the start and end. To cut out a part in the middle, drag across it on
        the timeline, then press Cut. Preview plays the result.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember" data-testid="trim-error">
          {error}
        </p>
      ) : null}

      <div className="clip-trim__footer">
        {clip.edited || clip.cuts.length > 0 ? (
          <button
            type="button"
            className="mr-auto text-sm text-ink-soft underline underline-offset-2 hover:text-ember"
            disabled={saving}
            onClick={() => void revert()}
            data-testid="trim-revert"
          >
            Restore the original
          </button>
        ) : null}
        <button type="button" className={secondaryButton} onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={saving || (!changed && clip.editStatus !== 'failed')}
          onClick={() => void save()}
          data-testid="trim-save"
        >
          {saving ? 'Saving…' : 'Save trim'}
        </button>
      </div>
    </section>
  )
}

/**
 * Frames from across the whole recording, drawn into the timeline's canvases from a second,
 * hidden video. Drawn, never read back, so a video from another origin (R2) needs no CORS.
 * Best effort: a frame that can't be drawn is a gap.
 */
function useThumbnails(src: string | null, durationMs: number) {
  const canvases = useRef<Array<HTMLCanvasElement | null>>([])
  useEffect(() => {
    if (!src || durationMs <= 0) return
    let cancelled = false
    const el = document.createElement('video')
    el.muted = true
    el.preload = 'auto'
    el.src = src
    const seekTo = (s: number) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          el.removeEventListener('seeked', done)
          el.removeEventListener('error', fail)
          resolve()
        }
        const fail = () => {
          el.removeEventListener('seeked', done)
          el.removeEventListener('error', fail)
          reject(new Error('no frame'))
        }
        el.addEventListener('seeked', done)
        el.addEventListener('error', fail)
        el.currentTime = s
      })
    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        el.addEventListener('loadeddata', () => resolve(), { once: true })
        el.addEventListener('error', () => reject(new Error('no video')), { once: true })
      })
      for (let i = 0; i < THUMBS && !cancelled; i++) {
        await seekTo(((i + 0.5) / THUMBS) * (durationMs / 1000))
        const canvas = canvases.current[i]
        if (cancelled || !canvas) continue
        const w = 160
        canvas.width = w
        canvas.height = Math.max(1, Math.round((w * (el.videoHeight || 9)) / (el.videoWidth || 16)))
        canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height)
        canvas.dataset.drawn = 'true'
      }
    }
    run().catch(() => {
      // Thumbnails are decoration: the timeline works without them.
    })
    return () => {
      cancelled = true
      el.removeAttribute('src')
      el.load()
    }
  }, [src, durationMs])
  return canvases
}
