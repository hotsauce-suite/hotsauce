import { useMemo } from 'react'
import { parseUnifiedDiff } from '../lib/unifiedDiff'

export function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  if (lines.length === 0) {
    return (
      <p className="px-1 py-3 text-sm text-ink-faint">
        No changes to this doc between these versions.
      </p>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-ash bg-paper">
      {lines.map((line, i) =>
        line.kind === 'hunk' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional.
          <div key={i} className="diff-hunk">
            {line.text}
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional.
            key={i}
            className={`diff-line ${line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : ''}`}
          >
            <span>{line.kind === 'add' ? '' : line.oldNo}</span>
            <span>{line.kind === 'del' ? '' : line.newNo}</span>
            <span>{line.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  )
}
