import { useLayoutEffect, useRef } from 'react'
import type { TranscriptSegment } from '../../../api/types'
import { Icon } from '../../../components/Icon'
import { formatClock } from '../format'

/** Within this many pixels of the end counts as "at the bottom", so new lines follow. */
const STICKY_PX = 24

function Segment({ segment }: { segment: TranscriptSegment }) {
  return (
    <li
      data-testid="transcript-segment"
      data-track={segment.track}
      data-final={segment.final}
      className="grid grid-cols-[3.25rem_1fr] gap-x-2 py-1"
    >
      <span
        className={`text-xs font-semibold leading-6 ${segment.track === 'me' ? 'text-ember-strong' : 'text-moss'}`}
      >
        {segment.speaker}
        <span className="block font-mono text-[0.68rem] leading-3 font-normal text-ink-faint">
          {formatClock(segment.at)}
        </span>
      </span>
      <span className={`text-sm leading-6 ${segment.final ? 'text-ink' : 'text-ink-faint italic'}`}>
        {segment.text}
      </span>
    </li>
  )
}

/**
 * The live transcript (PRD §6.3): collapsed by default to one line, the latest thing said;
 * expanded, a scrollable list that follows new lines only while you're at the bottom. Its
 * height never depends on the transcript, so streaming segments never move the notepad.
 */
export function LiveTranscript({
  segments,
  expanded,
  onToggle,
}: {
  segments: readonly TranscriptSegment[]
  expanded: boolean
  onToggle: () => void
}) {
  const list = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows each new segment.
  useLayoutEffect(() => {
    const el = list.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [segments, expanded])

  const latest = segments.at(-1)

  if (!expanded) {
    return (
      <div
        data-testid="live-transcript"
        data-expanded="false"
        className="flex h-12 shrink-0 items-center gap-3 border-t border-ash/70 bg-paper-raised/70 px-4"
      >
        <ol className="min-w-0 flex-1 truncate" aria-live="polite">
          {latest ? (
            <li
              data-testid="transcript-segment"
              data-track={latest.track}
              data-final={latest.final}
              className="truncate text-sm"
            >
              <span
                className={`mr-2 font-semibold ${latest.track === 'me' ? 'text-ember-strong' : 'text-moss'}`}
              >
                {latest.speaker}
              </span>
              <span className={latest.final ? 'text-ink-soft' : 'text-ink-faint italic'}>
                {latest.text}
              </span>
            </li>
          ) : (
            <li className="text-sm text-ink-faint">The transcript appears here as people talk.</li>
          )}
        </ol>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded="false"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="transcript" />
          Transcript
        </button>
      </div>
    )
  }

  return (
    <aside
      data-testid="live-transcript"
      data-expanded="true"
      aria-label="Live transcript"
      className="side-pane fixed inset-x-0 bottom-0 z-30 flex h-[55vh] flex-col border-t border-ash bg-paper-raised shadow-float md:static md:z-auto md:h-auto md:w-[var(--panel-width)] md:shrink-0 md:border-t-0 md:border-l md:bg-paper-raised/60 md:shadow-none"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-ash/70 px-4">
        <h2 className="font-display text-base font-semibold text-ink">Transcript</h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded="true"
          aria-label="Hide transcript"
          className="flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" />
        </button>
      </div>
      <ol
        ref={list}
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
      >
        {segments.length === 0 ? (
          <li className="py-2 text-sm text-ink-faint">
            The transcript appears here as people talk.
          </li>
        ) : (
          segments.map((segment) => (
            <Segment key={`${segment.track}:${segment.at}`} segment={segment} />
          ))
        )}
      </ol>
    </aside>
  )
}
