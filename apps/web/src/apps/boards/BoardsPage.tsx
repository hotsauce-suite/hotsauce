import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type BoardSummary, boardsApi } from '../../api/boards'
import { hotsauceSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { LoadError } from '../../components/LoadError'
import { useShortcut } from '../../keyboard/shortcuts'
import { boardUrl } from '../../lib/paths'
import { formatWhen } from '../clips/format'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { useNewBoard } from './useNewBoard'

type Scope = 'mine' | 'team'

/** `/boards`: the member's boards, or the team's, most recently changed first, searchable. */
export default function BoardsPage() {
  const [params, setParams] = useSearchParams()
  const scope: Scope = params.get('scope') === 'team' ? 'team' : 'mine'
  const [query, setQuery] = useState('')
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const newBoard = useNewBoard()
  useShortcut('global.create', () => {
    void newBoard.create(scope === 'team')
    return true
  })

  useEffect(() => {
    document.title = `${product()} Whiteboard`
  }, [])

  // Another member's new board shows up without a reload.
  useEffect(
    () =>
      hotsauceSocket.onChanged((e) => {
        if (e.paths.some((p) => p.startsWith('boards/'))) setTick((n) => n + 1)
      }),
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick refetches after a change.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        boardsApi.list(query.trim() ? { q: query.trim() } : {}).then(
          (list) => {
            if (cancelled) return
            setBoards(list)
            setFailed(false)
          },
          () => {
            if (!cancelled) setFailed(true)
          },
        )
      },
      query ? 200 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, tick])

  const shown = boards?.filter((b) => (scope === 'team' ? b.space === 'team' : b.space !== 'team'))

  const setScope = (next: Scope) => {
    const p = new URLSearchParams(params)
    if (next === 'team') p.set('scope', 'team')
    else p.delete('scope')
    setParams(p, { replace: true })
  }

  return (
    <>
      <MeetingsPageHeader title={`${product()} Whiteboard`}>
        <button
          type="button"
          className={`${primaryButton} h-9`}
          onClick={() => void newBoard.create(scope === 'team')}
          disabled={newBoard.busy}
          data-testid="boards-new-page"
        >
          <Icon name="plus" className="size-4" />
          <span>{scope === 'team' ? 'New team board' : 'New board'}</span>
        </button>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="boards-list">
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Whose boards" className="clips-tabs">
              {(['mine', 'team'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={scope === s}
                  data-testid={`boards-scope-${s}`}
                  onClick={() => setScope(s)}
                >
                  {s === 'mine' ? 'My boards' : 'Team'}
                </button>
              ))}
            </div>
            <label className="relative ml-auto w-full sm:w-72">
              <span className="sr-only">Search boards</span>
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles and text on boards"
                data-testid="boards-search"
                className="h-9 w-full rounded-lg border border-ash bg-paper-raised pr-3 pl-9 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
              />
            </label>
          </div>

          {newBoard.error ? (
            <p role="alert" className="mt-6 text-sm text-ember">
              {newBoard.error}
            </p>
          ) : null}
          {failed ? (
            <LoadError things="boards" onRetry={() => setTick((n) => n + 1)} className="mt-6" />
          ) : null}

          {!failed && shown?.length === 0 ? (
            <EmptyState
              icon="board"
              className="mt-4"
              title={
                query.trim()
                  ? 'No boards match that'
                  : scope === 'team'
                    ? 'No team boards yet'
                    : 'No boards yet'
              }
              action={
                query.trim() ? null : (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={newBoard.busy}
                    onClick={() => void newBoard.create(scope === 'team')}
                  >
                    <Icon name="plus" />
                    New board
                  </button>
                )
              }
            >
              {query.trim()
                ? 'Search looks at board titles and the words written on them.'
                : 'Sketch a flow, map an idea or draw a diagram. Boards save themselves as you draw.'}
            </EmptyState>
          ) : null}

          {shown && shown.length > 0 ? (
            <ul className="boards-grid mt-6">
              {shown.map((b) => (
                <li key={`${b.space}/${b.id}`}>
                  <Link
                    to={boardUrl(b.space, b.path)}
                    className="board-card group"
                    data-testid="board-card"
                  >
                    <div className="board-card__art" aria-hidden="true">
                      <Icon name="board" className="size-8" />
                    </div>
                    <div className="min-w-0 px-0.5">
                      <p
                        className="truncate font-medium text-ink group-hover:text-ember"
                        data-testid="board-card-title"
                      >
                        {b.title || 'Untitled board'}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-faint">
                        {b.space === 'team' ? 'Team · ' : ''}
                        {formatWhen(b.updated)}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </>
  )
}
