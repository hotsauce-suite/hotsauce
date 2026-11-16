// The one "couldn't load" block (docs/PLAN-consistency.md, requirement 1). Every app's list
// shows this when its request fails (above whatever had loaded before, if anything): the app's own noun, what to do, and a
// way to do it. The server's sentence is never shown; nothing in it helps the person reading.

interface LoadErrorProps {
  /** What didn't load, as the page calls it: "tasks", "team files", "calendar". */
  things: string
  /** Loads the list again, without reloading the page. */
  onRetry: () => void
  /** "your" for a member's own list (the default); "the" for something shared, or "" for a name. */
  whose?: 'your' | 'the' | ''
  className?: string
}

export function LoadError({ things, onRetry, whose = 'your', className = '' }: LoadErrorProps) {
  return (
    <div
      role="alert"
      data-testid="load-error"
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-ember/30 bg-ember/5 px-4 py-3 text-sm ${className}`}
    >
      <p className="min-w-0 flex-1 text-ink">
        <span className="font-medium">
          Couldn’t load {whose ? `${whose} ` : ''}
          {things}.
        </span>{' '}
        <span className="text-ink-soft">Check your connection and try again.</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-9 shrink-0 items-center rounded-lg border border-ash-strong bg-paper-raised px-3 font-medium text-ink hover:border-ember"
      >
        Try again
      </button>
    </div>
  )
}
