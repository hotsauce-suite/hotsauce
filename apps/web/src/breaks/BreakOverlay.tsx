import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BreakScene } from './BreakScene'
import { breaks } from './breaks'
import type { BreakView } from './runner'

// What the member sees of a screen break (docs/PLAN-breaks.md B7): a small heads-up ten seconds
// before, then the whole window dims for the break with a calming animation and a countdown.
// Skip and 5 more minutes are always there; Esc skips.

function useBreakView(): BreakView {
  const r = breaks()
  return useSyncExternalStore(r.subscribe, r.getView, r.getView)
}

/** Seconds left until `at`, ticking. */
function useSecondsUntil(at: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [at])
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000))
}

function clock(seconds: number): string {
  if (seconds < 60) return `${seconds}`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const quietButton =
  'rounded-full px-4 py-2 text-sm font-medium text-white/85 ring-1 ring-white/30 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white'

export function BreakOverlay() {
  const view = useBreakView()
  const { phase } = view
  const warnAt = phase.kind === 'warning' ? phase.startsAt : null
  const endAt = phase.kind === 'break' ? phase.endsAt : null
  const warnLeft = useSecondsUntil(warnAt)
  const left = useSecondsUntil(endAt)
  const skipRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (phase.kind !== 'break') return
    skipRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        breaks().skip()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase.kind])

  if (!view.leader) return null

  if (phase.kind === 'warning') {
    return (
      <div
        role="status"
        data-testid="break-warning"
        className="break-fade-in fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-ash bg-paper-raised px-4 py-3 shadow-lg"
      >
        <BreakScene animation={view.settings.animation} className="size-8 shrink-0" />
        <span className="text-sm text-ink">
          Screen break in <span className="tabular-nums">{warnLeft}s</span>
        </span>
        <button
          type="button"
          data-testid="break-start-now"
          onClick={() => breaks().startNow()}
          className="rounded-full bg-ember px-3 py-1 text-xs font-medium text-paper hover:bg-ember-strong"
        >
          Start now
        </button>
        <button
          type="button"
          data-testid="break-snooze"
          onClick={() => breaks().snooze()}
          className="text-xs text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
        >
          5 more minutes
        </button>
        <button
          type="button"
          data-testid="break-skip"
          onClick={() => breaks().skip()}
          className="text-xs text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
        >
          Skip
        </button>
      </div>
    )
  }

  if (phase.kind !== 'break') return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="break-title"
      data-testid="break-overlay"
      className="break-fade-in fixed inset-0 z-[70] flex flex-col items-center justify-center gap-8 bg-[#0f1424]/85 px-6 text-center text-white backdrop-blur-md"
    >
      <BreakScene
        animation={view.settings.animation}
        testId="break-scene"
        className="size-56 sm:size-72"
      />
      <div>
        <h2 id="break-title" className="font-display text-2xl font-semibold tracking-tight">
          Look at something far away
        </h2>
        <p className="mt-1 text-white/70">Let your eyes rest and your shoulders drop.</p>
        <p
          data-testid="break-countdown"
          aria-live="off"
          className="mt-5 font-display text-5xl font-semibold tabular-nums"
        >
          {clock(left)}
        </p>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          ref={skipRef}
          data-testid="break-overlay-skip"
          onClick={() => breaks().skip()}
          className={quietButton}
        >
          Skip
        </button>
        <button
          type="button"
          data-testid="break-overlay-snooze"
          onClick={() => breaks().snooze()}
          className={quietButton}
        >
          5 more minutes
        </button>
      </div>
    </div>
  )
}
