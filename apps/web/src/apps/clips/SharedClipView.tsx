import { useEffect, useRef, useState } from 'react'
import type { SharedClip } from '../../api/shares'
import { activeLine, formatDuration, formatTimestamp } from './format'
import { loadSpeed, SPEEDS, saveSpeed, speedLabel } from './speed'

/**
 * A clip as its read-only link shows it (docs/PLAN-outside-links.md R6): the video with speed
 * buttons, the summary and the transcript (a line seeks). Nothing from the organization's side
 * of the clip: no notes, action items, comments or download.
 */
export function SharedClipView({ clip }: { clip: SharedClip }) {
  const video = useRef<HTMLVideoElement>(null)
  const [speed, setSpeed] = useState(loadSpeed)
  const [time, setTime] = useState(0)
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed
  }, [speed])
  const starts = clip.transcript.map((s) => s.start)
  const current = activeLine(starts, time)
  const seek = (t: number) => {
    const v = video.current
    if (!v) return
    v.currentTime = t
    void v.play().catch(() => {})
  }
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-6"
      data-testid="shared-clip"
    >
      <h1 className="font-display text-2xl font-semibold text-ink">{clip.title}</h1>
      {clip.videoUrl ? (
        // biome-ignore lint/a11y/useMediaCaption: the transcript beside it is the text alternative
        <video
          ref={video}
          src={clip.videoUrl}
          poster={clip.thumbUrl ?? undefined}
          controls
          controlsList="nodownload"
          playsInline
          preload="metadata"
          className="aspect-video w-full rounded-xl bg-ink"
          data-testid="shared-clip-video"
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = speed
          }}
        />
      ) : (
        <p className="text-ink-soft">This clip can’t be played right now.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="clip-speeds" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === speed}
              data-testid={`shared-clip-speed-${s}`}
              onClick={() => {
                setSpeed(s)
                saveSpeed(s)
              }}
            >
              {speedLabel(s)}
            </button>
          ))}
        </fieldset>
        {clip.durationMs ? (
          <span className="ml-auto text-xs text-ink-faint">{formatDuration(clip.durationMs)}</span>
        ) : null}
      </div>
      {clip.summary ? (
        <p className="text-ink" data-testid="shared-clip-summary">
          {clip.summary}
        </p>
      ) : null}
      {clip.transcript.length ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">Transcript</h2>
          <ol className="flex flex-col" data-testid="shared-clip-transcript">
            {clip.transcript.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder; two can share a start.
              <li key={i}>
                <button
                  type="button"
                  onClick={() => seek(line.start)}
                  aria-current={i === current ? 'true' : undefined}
                  className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-sm ${i === current ? 'bg-ember-wash text-ink' : 'text-ink-soft hover:bg-paper-sunk'}`}
                >
                  <span className="w-10 shrink-0 font-mono text-xs leading-5 text-ink-faint">
                    {formatTimestamp(line.start)}
                  </span>
                  <span>
                    {line.speaker ? (
                      <span className="font-medium text-ink">{line.speaker}: </span>
                    ) : null}
                    {line.text}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}
