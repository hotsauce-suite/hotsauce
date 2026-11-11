import { useEffect, useState } from 'react'
import { product } from '../brand/product'
import type { SaveState as SaveStateValue } from '../hooks/useDocument'
import { relativeTime } from '../lib/time'

interface SaveStateProps {
  state: SaveStateValue
  isNew: boolean
  lastCommittedAt: number | null
  error: string | null
  compact?: boolean
}

function label({ state, isNew, lastCommittedAt, compact }: SaveStateProps, now: number): string {
  switch (state) {
    case 'dirty':
      return 'Editing'
    case 'saving':
      return 'Saving…'
    case 'saved':
      return compact ? 'On device' : 'Saved on this device'
    case 'conflict':
      return 'Conflict'
    case 'committed':
      if (isNew) return 'New doc'
      if (compact || !lastCommittedAt) return 'Committed'
      return `Committed · ${relativeTime(lastCommittedAt, now)}`
  }
}

const titles = (): Record<SaveStateValue, string> => ({
  dirty: `Unsaved edits. ${product()} commits them after a pause, when you leave, or on Save version.`,
  saving: 'Committing to Git…',
  saved: `Kept on this device; ${product()} will retry the commit.`,
  committed: 'Everything here is committed to Git.',
  conflict: 'Someone else changed the same lines. Resolve to save.',
})

/** The save chip: an ember that glows while edits are unsaved and settles once committed. */
export function SaveState(props: SaveStateProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (props.state !== 'committed' || !props.lastCommittedAt) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [props.state, props.lastCommittedAt])

  return (
    <output
      data-testid="save-state"
      data-state={props.state}
      title={props.error ? `${titles()[props.state]} (${props.error})` : titles()[props.state]}
      aria-live="polite"
      className={`flex h-7 shrink-0 items-center gap-2 rounded-full text-xs whitespace-nowrap text-ink-soft ${
        props.compact && props.state === 'committed'
          ? 'px-2'
          : 'border border-ash bg-paper-raised/70 px-2.5'
      }`}
    >
      <span className="ember-dot" aria-hidden="true" />
      {/* On a phone, a settled ember says enough; words appear only when something's happening. */}
      <span className={props.compact && props.state === 'committed' ? 'sr-only' : undefined}>
        {label(props, now)}
      </span>
    </output>
  )
}
