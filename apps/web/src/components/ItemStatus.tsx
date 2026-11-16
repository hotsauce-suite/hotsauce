// The status on the page of one thing (docs/PLAN-consistency.md, round 4, requirement 22): whose
// it is ("Personal" or "Team") in small words, then the same save chip a doc shows. It sits first
// among the top bar's controls, before Share.

export type ItemSave = 'saved' | 'unsaved' | 'saving' | 'error'

const WORDS: Record<ItemSave, string> = {
  saved: 'Saved',
  unsaved: 'Editing',
  saving: 'Saving…',
  error: 'Not saved',
}

const TITLES: Record<ItemSave, string> = {
  saved: 'Everything here is saved.',
  unsaved: 'Your changes save after a pause.',
  saving: 'Saving your changes…',
  error: 'Not saved. Check your connection; it tries again on your next change.',
}

// The doc chip's ember reads these states (styles/app.css).
const DOT_STATE: Record<ItemSave, string> = {
  saved: 'committed',
  unsaved: 'dirty',
  saving: 'saving',
  error: 'conflict',
}

export function ItemStatus({
  whose,
  save,
  words,
  error,
  title,
  testId,
}: {
  /** "Personal" or "Team". Hidden on a phone, where the top bar has no room for it. */
  whose?: string | undefined
  /** Left out for a thing that has nothing to save as you type (a clip, a page). */
  save?: ItemSave | undefined
  /** The chip's words when they differ from the state's own ("Unsaved changes"). */
  words?: string | undefined
  /** What went wrong, shown on hover. */
  error?: string | undefined
  /** The hover text when it differs from the state's own. */
  title?: string | undefined
  testId?: string | undefined
}) {
  return (
    <span data-testid="item-status" className="flex shrink-0 items-center gap-2">
      {whose ? (
        <span data-testid="item-whose" className="hidden text-xs text-ink-faint sm:inline">
          {whose}
        </span>
      ) : null}
      {save ? (
        <output
          data-testid={testId}
          data-state={DOT_STATE[save]}
          aria-live="polite"
          title={error ? `${TITLES[save]} (${error})` : (title ?? TITLES[save])}
          className={`flex h-7 shrink-0 items-center gap-2 rounded-full border border-ash bg-paper-raised/70 px-2.5 text-xs whitespace-nowrap ${
            save === 'error' ? 'text-ember-strong' : 'text-ink-soft'
          }`}
        >
          <span className="ember-dot" aria-hidden="true" />
          <span>{words ?? WORDS[save]}</span>
        </output>
      ) : null}
    </span>
  )
}
