import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Commit } from '../api/types'
import { relativeTime } from '../lib/time'
import { DiffView } from './DiffView'
import { Icon } from './Icon'
import type { ResolveImage } from './ReadingView'
import { SidePanel } from './SidePanel'

const ReadingView = lazy(() => import('./ReadingView'))

interface HistoryPanelProps {
  space: string
  path: string
  /** Changes whenever this client commits, so the list picks up the new entry. */
  refreshKey: number | null
  resolveImage: ResolveImage
  onRestore: (oid: string) => Promise<void>
  onClose: () => void
}

export default function HistoryPanel({
  space,
  path,
  refreshKey,
  resolveImage,
  onRestore,
  onClose,
}: HistoryPanelProps) {
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger to reload.
  useEffect(() => {
    let live = true
    api.history(space, path, 50).then(
      (list) => live && setCommits(list),
      (err: unknown) =>
        live && setError(err instanceof Error ? err.message : 'Couldn’t load history.'),
    )
    return () => {
      live = false
    }
  }, [space, path, refreshKey])

  return (
    <SidePanel title="History" onClose={onClose}>
      {error ? <p className="p-4 text-sm text-ember-strong">{error}</p> : null}
      {commits === null && !error ? (
        <p className="p-4 text-sm text-ink-faint">Loading history…</p>
      ) : null}
      {commits?.length === 0 ? (
        <p className="p-4 text-sm text-ink-faint">No commits yet. The first save creates one.</p>
      ) : null}
      <ol className="p-2">
        {commits?.map((commit, index) => {
          const isOpen = commit.oid === selected
          return (
            <li key={commit.oid} className="mb-1">
              <button
                type="button"
                data-testid="history-item"
                data-oid={commit.oid}
                aria-expanded={isOpen}
                onClick={() => setSelected(isOpen ? null : commit.oid)}
                className={`w-full rounded-lg px-3 py-2 text-left ${isOpen ? 'bg-ember-wash' : 'hover:bg-paper-sunk/70'}`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {commit.author.name}
                  </span>
                  <time dateTime={commit.date} className="shrink-0 text-xs text-ink-faint">
                    {relativeTime(commit.date)}
                  </time>
                </span>
                {commit.label ? (
                  <span className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ember-strong">
                    <Icon name="flag" className="size-3.5" />
                    {commit.label}
                  </span>
                ) : null}
                <span className="mt-0.5 block truncate text-xs text-ink-soft">
                  {commit.message}
                </span>
              </button>
              {isOpen ? (
                <CommitDetail
                  space={space}
                  path={path}
                  commit={commit}
                  older={commits.slice(index + 1)}
                  isCurrent={index === 0}
                  resolveImage={resolveImage}
                  onRestore={onRestore}
                />
              ) : null}
            </li>
          )
        })}
      </ol>
    </SidePanel>
  )
}

function CommitDetail({
  space,
  path,
  commit,
  older,
  isCurrent,
  resolveImage,
  onRestore,
}: {
  space: string
  path: string
  commit: Commit
  older: Commit[]
  isCurrent: boolean
  resolveImage: ResolveImage
  onRestore: (oid: string) => Promise<void>
}) {
  const [view, setView] = useState<'changes' | 'version'>(older.length ? 'changes' : 'version')
  const [compareTo, setCompareTo] = useState(older[0]?.oid ?? '')
  const [diff, setDiff] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (view !== 'changes' || !compareTo) return
    let live = true
    setDiff(null)
    api.diff(space, compareTo, commit.oid, path).then(
      (r) => live && setDiff(r.diff),
      () => live && setDiff(''),
    )
    return () => {
      live = false
    }
  }, [view, compareTo, space, path, commit.oid])

  useEffect(() => {
    if (view !== 'version') return
    let live = true
    api.show(space, commit.oid, path).then(
      (r) => live && setContent(r.content),
      () => live && setContent(''),
    )
    return () => {
      live = false
    }
  }, [view, space, path, commit.oid])

  const restore = async () => {
    setRestoring(true)
    try {
      await onRestore(commit.oid)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="mx-1 mt-1 mb-3 rounded-lg border border-ash bg-paper p-2">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {older.length ? (
          <ViewTab active={view === 'changes'} onClick={() => setView('changes')}>
            Changes
          </ViewTab>
        ) : null}
        <ViewTab active={view === 'version'} onClick={() => setView('version')}>
          This version
        </ViewTab>
        {isCurrent ? null : (
          <button
            type="button"
            data-testid="restore"
            onClick={() => void restore()}
            disabled={restoring}
            className="ml-auto rounded-md bg-ember px-2.5 py-1 text-xs font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
          >
            {restoring ? 'Restoring…' : 'Restore'}
          </button>
        )}
      </div>
      {view === 'changes' ? (
        <>
          {older.length > 1 ? (
            <label className="mb-2 flex items-center gap-2 text-xs text-ink-soft">
              Compared with
              <select
                value={compareTo}
                onChange={(event) => setCompareTo(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-ash bg-paper-raised px-1.5 py-1 text-xs text-ink"
              >
                {older.map((c) => (
                  <option key={c.oid} value={c.oid}>
                    {c.label ?? c.message} ({relativeTime(c.date)}, {c.author.name})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {diff === null ? (
            <p className="p-2 text-xs text-ink-faint">Loading changes…</p>
          ) : (
            <DiffView diff={diff} />
          )}
        </>
      ) : content === null ? (
        <p className="p-2 text-xs text-ink-faint">Loading this version…</p>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto rounded-md text-[0.8rem] [&_.prose-hearth]:p-2">
          <Suspense fallback={null}>
            <ReadingView
              markdown={content}
              space={space}
              path={path}
              resolveImage={resolveImage}
              embedded
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs ${active ? 'bg-paper-sunk font-medium text-ink' : 'text-ink-soft hover:text-ink'}`}
    >
      {children}
    </button>
  )
}
