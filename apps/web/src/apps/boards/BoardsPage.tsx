import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type BoardSummary, boardsApi } from '../../api/boards'
import { hotsauceSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { ListBar, ListColumn, scopeTabs, useScope } from '../../components/ListBar'
import { LoadError } from '../../components/LoadError'
import { MainButton } from '../../components/PageHeader'
import { useShortcut } from '../../keyboard/shortcuts'
import { boardUrl } from '../../lib/paths'
import { formatWhen } from '../clips/format'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { useNewBoard } from './useNewBoard'

/** `/boards`: the member's boards, or the team's, most recently changed first, searchable. */
export default function BoardsPage() {
  const [scope, setScope] = useScope(['mine', 'team'])
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
    document.title = `${product()} Boards`
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

  return (
    <>
      <MeetingsPageHeader title="Boards">
        <MainButton
          icon="plus"
          onClick={() => void newBoard.create(scope === 'team')}
          disabled={newBoard.busy}
          testId="boards-new-page"
        >
          {scope === 'team' ? 'New team board' : 'New board'}
        </MainButton>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="boards-list">
        <ListColumn width="gallery">
          <ListBar
            tabs={scopeTabs(['mine', 'team'], 'boards')}
            tab={scope}
            onTab={setScope}
            tabsLabel="Whose boards"
            search={{
              value: query,
              onChange: setQuery,
              label: 'Search boards',
              placeholder: 'Search titles and text on boards',
              testId: 'boards-search',
            }}
            className=""
          />

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
        </ListColumn>
      </div>
    </>
  )
}
