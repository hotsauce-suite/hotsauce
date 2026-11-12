import { useEffect, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { type BoardView, boardsApi } from '../../api/boards'
import { HearthApiError } from '../../api/client'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader } from '../meetings/components/common'
import { BoardCanvas, type BoardCanvasHandle } from './BoardCanvas'
import { type Peer, peerColor } from './collab'
import type { SaveStatus } from './session'

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Editing',
  error: 'Not saved',
}

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
  const [copied, setCopied] = useState(false)
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
          err instanceof HearthApiError && err.status === 404
            ? 'This board doesn’t exist, or it was deleted.'
            : err instanceof HearthApiError && err.status === 403
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
    document.title = `${board?.title || 'Untitled board'} · ${product()} Whiteboard`
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
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setStatus({ s: 'error', error: `Copy this into a doc: ${text}` })
    }
  }

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
        <MeetingsPageHeader title={`${product()} Whiteboard`} />
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
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Link to="/boards" aria-label="All boards" className="text-ink-faint hover:text-ink">
              <Icon name="back" className="size-4" />
            </Link>
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
            <span className="hidden text-xs text-ink-faint sm:inline">
              {board.space === 'team' ? 'Team' : 'Private'}
            </span>
            <span
              className={`text-xs ${status.s === 'error' ? 'text-ember' : 'text-ink-faint'}`}
              data-testid="board-status"
              role="status"
              title={status.error}
            >
              {STATUS_TEXT[status.s]}
            </span>
            <button
              type="button"
              onClick={() => void copyEmbed()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink"
              data-testid="board-copy-embed"
              title="Copy a link that shows this board inside a doc"
            >
              <Icon name="link" className="size-4" />
              <span className="hidden md:inline">{copied ? 'Copied' : 'Embed in a doc'}</span>
            </button>
            {confirmDelete ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="h-8 rounded-md bg-ember px-2 text-sm text-paper-raised"
                  data-testid="board-delete-confirm"
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
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete board"
                className="inline-flex size-8 items-center justify-center rounded-md text-ink-soft hover:bg-paper-sunk hover:text-ember"
                data-testid="board-delete"
              >
                <Icon name="trash" className="size-4" />
              </button>
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
