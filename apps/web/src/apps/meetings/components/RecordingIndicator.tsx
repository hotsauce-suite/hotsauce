import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { formatClock } from '../format'
import type { LiveSnapshot } from '../live/liveState'

/** The current time, re-read every `intervalMs`; only the component using it re-renders. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const now = useNow()
  // Fixed width and tabular digits: the clock ticking never moves anything around it.
  return (
    <span className="inline-block min-w-[4.5ch] font-mono text-[0.8rem] tabular-nums">
      {formatClock(now - Date.parse(startedAt))}
    </span>
  )
}

const stateLabel = (live: LiveSnapshot) =>
  live.state === 'paused' ? 'Paused' : live.capturing ? 'Recording' : 'Not capturing'

/**
 * The persistent recording indicator (PRD §6.9). Exactly one is on screen while a meeting is
 * live: in the live page's header, or as a strip across the top of any other page.
 */
export function RecordingIndicator({
  live,
  variant,
}: {
  live: LiveSnapshot
  variant: 'inline' | 'strip'
}) {
  const recording = live.state === 'recording'
  const dot = <span aria-hidden="true" className={`rec-dot ${recording ? 'rec-dot-live' : ''}`} />
  if (variant === 'inline') {
    return (
      <div
        data-testid="recording-indicator"
        data-state={live.state}
        role="status"
        className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-ash bg-paper-raised/70 px-3 text-sm text-ink"
      >
        {dot}
        {/* On a phone the dot and the clock say it; the title needs the room. */}
        <span className="hidden font-medium sm:inline">{stateLabel(live)}</span>
        <Elapsed startedAt={live.startedAt} />
      </div>
    )
  }
  return (
    <Link
      to={`/meetings/live/${encodeURIComponent(live.id)}`}
      data-testid="recording-indicator"
      data-state={live.state}
      className="flex h-9 shrink-0 items-center gap-2.5 border-b border-ember/25 bg-ember-wash px-4 text-sm text-ink hover:bg-ember/15"
    >
      {dot}
      <span className="font-medium text-ember-strong">{stateLabel(live)}</span>
      <Elapsed startedAt={live.startedAt} />
      <span className="min-w-0 truncate text-ink-soft">{live.title}</span>
      <span className="ml-auto shrink-0 text-ember-strong">Back to notes</span>
    </Link>
  )
}
