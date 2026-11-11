import type { ReactNode } from 'react'
import { relativeTime } from '../lib/time'

function Banner({
  tone,
  children,
  testId,
}: {
  tone: 'ember' | 'ash'
  children: ReactNode
  testId?: string
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-sm ${
        tone === 'ember'
          ? 'border-ember/30 bg-ember-wash text-ink'
          : 'border-ash bg-paper-sunk/70 text-ink-soft'
      }`}
    >
      {children}
    </div>
  )
}

export function ConflictBanner({ onResolve }: { onResolve: () => void }) {
  return (
    <Banner tone="ember" testId="conflict-banner">
      <span className="font-medium">This doc has changes that conflict with yours.</span>
      <span className="text-ink-soft">
        Nothing is lost; both versions are kept until you choose.
      </span>
      <button
        type="button"
        onClick={onResolve}
        className="ml-auto rounded-md bg-ember px-2.5 py-1 text-xs font-medium text-paper-raised hover:bg-ember-strong"
      >
        Resolve
      </button>
    </Banner>
  )
}

export function DraftBanner({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: number
  onRestore: () => void
  onDiscard: () => void
}) {
  return (
    <Banner tone="ash">
      <span>
        You have unsaved edits to this doc from {savedAt ? relativeTime(savedAt) : 'earlier'} on
        this device.
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={onRestore}
          className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper hover:bg-ink-soft"
        >
          Restore them
        </button>
        <button type="button" onClick={onDiscard} className="px-1 text-xs hover:text-ink">
          Discard
        </button>
      </span>
    </Banner>
  )
}
