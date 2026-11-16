import { useEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { type BoardView, boardsApi } from '../../api/boards'
import { HotsauceApiError } from '../../api/client'
import { product } from '../../brand/product'
import { useShell } from '../../components/AppShell'
import { ItemStatus } from '../../components/ItemStatus'
import { MenuItem } from '../../components/Menu'
import { MoreMenu } from '../../components/PageHeader'
import { ShareButton } from '../../components/ShareButton'
import { useSession } from '../../state/session'
import { MeetingsPageHeader } from '../meetings/components/common'
import { BoardCanvas, type BoardCanvasHandle } from './BoardCanvas'
import { type Peer, peerColor } from './collab'
import type { SaveStatus } from './session'

/** `/boards/:space/:id`: one board, drawn in Excalidraw, saved as you go. */
export default function BoardRoute() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const [board, setBoard] = useState<BoardView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ s: SaveStatus; error?: string | undefined }>({
    s: 'saved',
  })
  const [title, setTitle] = useState('')
  const { notify } = useSession()
  const { compact } = useShell()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const canvas = useRef<BoardCanvasHandle | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])

  useEffect(() => {
    let cancelled = false
    setBoard(null)
    setLoadError(null)
    boardsApi.get(space, id).then(
      (b) => {
        if (cancelled) return
        setBoard(b)
        setTitle(b.title)
      },
      (err: unknown) => {
        if (cancelled) return
        setLoadError(
          err instanceof HotsauceApiError && err.status === 404
            ? 'This board doesn’t exist, or it was deleted.'
            : err instanceof HotsauceApiError && err.status === 403
              ? 'This board is in someone else’s private space.'
              : 'Couldn’t open the board. Check your connection and try again.',
        )
      },
    )
    return () => {
      cancelled = true
    }
  }, [space, id])

  useEffect(() => {
    document.title = `${board?.title || 'Untitled board'} · ${product()} Boards`
  }, [board?.title])

  // Leaving with unsaved strokes saves them first.
  const blocker = useBlocker(() => canvas.current?.dirty() ?? false)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const h = canvas.current
    void (h ? h.flush() : Promise.resolve()).then(
      () => blocker.proceed(),
      (err: unknown) => {
        // A save that keeps failing (the board was deleted, access lost) must not trap anyone.
        const why = err instanceof Error ? err.message : 'The board couldn’t be saved'
        if (window.confirm(`${why}. Leave without saving the last changes?`)) blocker.proceed()
        else blocker.reset()
      },
    )
  }, [blocker])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (canvas.current?.dirty()) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const saveTitle = async () => {
    if (!board || title.trim() === board.title) return
    try {
      const saved = await boardsApi.save(board.space, board.id, { title })
      setBoard((b) => (b ? { ...b, title: saved.title } : b))
      setTitle(saved.title)
    } catch (err) {
      setStatus({ s: 'error', error: err instanceof Error ? err.message : 'Couldn’t rename' })
    }
  }

  const copyEmbed = async () => {
    if (!board) return
    const name = (board.title || 'Board').replace(/[[\]]/g, '')
    const text = `[![${name}](/${board.path})](/${board.path})`
    try {
      await navigator.clipboard.writeText(text)
      notify('Copied. Paste it into a doc to show this board there.')
    } catch {
      setStatus({ s: 'error', error: `Copy this into a doc: ${text}` })
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Link copied. Anyone who can see this board can open it.')
    } catch {
      notify('Couldn’t copy the link. Copy it from the address bar instead.')
    }
  }

  const shareItems = (close: () => void) => (
    <>
      <MenuItem
        icon="link"
        testId="board-copy-link"
        onSelect={() => {
          close()
          void copyLink()
        }}
      >
        Copy link
      </MenuItem>
      <MenuItem
        icon="copy"
        testId="board-copy-embed"
        onSelect={() => {
          close()
          void copyEmbed()
        }}
      >
        Copy to paste into a doc
      </MenuItem>
    </>
  )

  const remove = async () => {
    if (!board) return
    try {
      await boardsApi.remove(board.space, board.id)
      canvas.current = null
      navigate(board.space === 'team' ? '/boards?scope=team' : '/boards')
    } catch (err) {
      setStatus({ s: 'error', error: err instanceof Error ? err.message : 'Couldn’t delete' })
    }
  }

  if (loadError) {
    return (
      <>
        <MeetingsPageHeader title="Boards" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-ink" role="alert">
            {loadError}
          </p>
          <Link to="/boards" className="text-sm text-ember hover:underline">
            Back to boards
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <MeetingsPageHeader
        back={{ to: '/boards', label: 'Boards' }}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <input
              aria-label="Board title"
              className="board-title-input"
              value={title}
              placeholder="Untitled board"
              disabled={!board}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              data-testid="board-title"
            />
          </span>
        }
      >
        {board ? (
          <>
            {peers.length > 0 ? (
              <span
                className="flex items-center -space-x-1.5"
                data-testid="board-peers"
                title={`${peers.map((p) => p.name).join(', ')} ${peers.length === 1 ? 'is' : 'are'} here`}
              >
                {peers.slice(0, 5).map((p) => (
                  <span
                    key={p.id}
                    role="img"
                    aria-label={`${p.name} is here`}
                    className="inline-flex size-6 items-center justify-center rounded-full border-2 border-paper-raised text-[10px] font-semibold"
                    style={{
                      background: peerColor(p.email).background,
                      color: peerColor(p.email).stroke,
                    }}
                  >
                    {initials(p.name)}
                  </span>
                ))}
                {peers.length > 5 ? (
                  <span className="pl-2 text-xs text-ink-faint">+{peers.length - 5}</span>
                ) : null}
              </span>
            ) : null}
            <ItemStatus
              whose={board.space === 'team' ? 'Team' : 'Personal'}
              save={status.s}
              error={status.error}
              testId="board-status"
            />
            {compact ? null : <ShareButton testId="board-share">{shareItems}</ShareButton>}
            {confirmDelete ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="h-8 rounded-md bg-ember px-2 text-sm text-paper-raised"
                  data-testid="board-delete-confirm"
                  // biome-ignore lint/a11y/noAutofocus: chosen from More, which closes as this appears
                  autoFocus
                >
                  Delete board
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="h-8 rounded-md px-2 text-sm text-ink-soft hover:text-ink"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <MoreMenu>
                {(close) => (
                  <>
                    {compact ? shareItems(close) : null}
                    <MenuItem
                      icon="trash"
                      danger
                      testId="board-delete"
                      onSelect={() => {
                        close()
                        setConfirmDelete(true)
                      }}
                    >
                      Delete board
                    </MenuItem>
                  </>
                )}
              </MoreMenu>
            )}
          </>
        ) : null}
      </MeetingsPageHeader>
      {status.s === 'error' && status.error ? (
        <p
          role="alert"
          className="border-b border-ash/70 bg-paper-sunk px-4 py-2 text-sm text-ember"
        >
          {status.error}
        </p>
      ) : null}
      {board ? (
        <BoardCanvas
          key={`${board.space}/${board.id}`}
          board={board}
          onStatus={(s, error) =>
            setStatus((prev) => (prev.s === s && prev.error === error ? prev : { s, error }))
          }
          handle={(h) => {
            canvas.current = h
          }}
          onPeers={setPeers}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
          Opening board…
        </div>
      )}
    </>
  )
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}
