import { useMemo, useState } from 'react'
import { hasConflictMarkers } from '../lib/merge3'
import { displayName } from '../lib/paths'
import { Dialog } from './Dialog'

interface ConflictResolverProps {
  path: string
  ours: string
  theirs: string
  onResolve: (content: string) => Promise<void>
  /**
   * Absent when the conflict exists only in this tab (no server branch keeps "mine"): closing
   * without a result could then lose the other person's change, so it isn't offered.
   */
  onCancel?: () => void
}

/** Lines of `text` that don't appear anywhere in `other`, to show where the versions differ. */
function differingLines(text: string, other: string): Set<number> {
  const otherLines = new Set(other.split('\n'))
  const differing = new Set<number>()
  text.split('\n').forEach((line, i) => {
    if (!otherLines.has(line)) differing.add(i)
  })
  return differing
}

function Version({ title, text, other }: { title: string; text: string; other: string }) {
  const marked = useMemo(() => differingLines(text, other), [text, other])
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h3 className="mb-1.5 text-sm font-medium text-ink-soft">{title}</h3>
      <pre className="max-h-[32vh] min-h-24 overflow-auto rounded-lg border border-ash bg-paper p-3 font-mono text-[0.78rem] leading-relaxed whitespace-pre-wrap text-ink">
        {text.split('\n').map((line, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder.
            key={i}
            className={`block ${marked.has(i) ? '-mx-1 rounded bg-ember-wash px-1' : ''}`}
          >
            {line || ' '}
          </span>
        ))}
      </pre>
    </section>
  )
}

export function ConflictResolver({
  path,
  ours,
  theirs,
  onResolve,
  onCancel,
}: ConflictResolverProps) {
  const [result, setResult] = useState(ours)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unresolved = hasConflictMarkers(result)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onResolve(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the resolution. Try again.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Resolve changes to “${displayName(path)}”`}
      onClose={onCancel ?? (() => {})}
      wide
      testId="conflict-resolver"
    >
      <p className="mb-4 max-w-2xl text-sm text-ink-soft">
        Someone else changed the same lines while you were editing. Both versions are kept until you
        save a result here. Highlighted lines differ between the two.
      </p>
      <div className="mb-4 flex flex-col gap-4 md:flex-row">
        <Version title="Your version" text={ours} other={theirs} />
        <Version title="Their version" text={theirs} other={ours} />
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-medium text-ink-soft">Result</span>
        <button
          type="button"
          data-testid="resolve-use-mine"
          onClick={() => setResult(ours)}
          className="rounded-lg border border-ash px-3 py-1.5 text-sm text-ink hover:border-ember"
        >
          Use mine
        </button>
        <button
          type="button"
          data-testid="resolve-use-theirs"
          onClick={() => setResult(theirs)}
          className="rounded-lg border border-ash px-3 py-1.5 text-sm text-ink hover:border-ember"
        >
          Use theirs
        </button>
      </div>
      <textarea
        aria-label="Resolved text"
        value={result}
        onChange={(event) => setResult(event.target.value)}
        spellCheck={false}
        className="mb-3 h-[24vh] w-full resize-y rounded-lg border border-ash bg-paper p-3 font-mono text-[0.8rem] leading-relaxed text-ink outline-none focus:border-ember"
      />
      {unresolved ? (
        <p className="mb-3 text-sm text-ember-strong">
          The result still has conflict markers (&lt;&lt;&lt;&lt;&lt;&lt;&lt;). Edit them out before
          saving.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-ink-soft hover:text-ink"
          >
            Decide later
          </button>
        ) : null}
        <button
          type="button"
          data-testid="resolve-save"
          onClick={() => void save()}
          disabled={busy || unresolved}
          className="rounded-lg bg-ember px-3.5 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save result'}
        </button>
      </div>
    </Dialog>
  )
}
