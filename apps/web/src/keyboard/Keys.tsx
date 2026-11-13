import { Fragment } from 'react'
import { formatSpec } from './keys'

/** One key spec as keycaps: "g d" → g then d; "mod+k" → ⌘K (Ctrl+K off a Mac). */
export function Keys({ spec, className = '' }: { spec: string; className?: string }) {
  const caps = formatSpec(spec)
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {caps.map((cap, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: strokes are positional.
        <Fragment key={i}>
          {i > 0 ? <span className="text-[0.68rem] text-ink-faint">then</span> : null}
          <kbd className="min-w-[1.4rem] rounded-md border border-ash-strong border-b-2 bg-paper-sunk px-1.5 py-px text-center font-mono text-[0.72rem] text-ink-soft">
            {cap}
          </kbd>
        </Fragment>
      ))}
    </span>
  )
}
