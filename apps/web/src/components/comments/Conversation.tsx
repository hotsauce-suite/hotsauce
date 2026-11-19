import { useEffect, useRef, useState } from 'react'
import type { Comment } from '../../api/comments'
import { PersonFace } from '../../profile/MemberFace'
import { Icon } from '../Icon'
import { Composer } from './Composer'
import { CommentText, commentWhen } from './commentText'
import type { Conversation as ConversationState } from './useComments'

/** How many comments a long conversation shows before "Show earlier comments" (R11). */
export const COMMENTS_SHOWN = 20

/** The comment a `#comment-<id>` link points at, or null. */
export function commentIdFromHash(hash: string): string | null {
  const match = /^#comment-([A-Za-z0-9]+)$/.exec(hash)
  return match ? (match[1] ?? null) : null
}

export interface ConversationProps {
  conversation: ConversationState
  /** The comment to land on (from a push or a link), scrolled to and marked. */
  focusId?: string | null
  /** Bumped to put the cursor in the comment box ("Comment" on a selection, the top bar). */
  focusBox?: number
  /** Brings the conversation into view first, where it can be scrolled away (the editor). */
  onReveal?: () => void
  /** Tighter, for the task panel. */
  dense?: boolean
}

const quietButton = 'text-xs text-ink-faint hover:text-ink hover:underline disabled:opacity-50'

/** Runs `act` on the element once it is in the page (the editor draws its end lazily). */
function whenConnected(find: () => HTMLElement | null, act: (el: HTMLElement) => void): () => void {
  let frame = 0
  let tries = 0
  const tick = () => {
    const el = find()
    if (el?.isConnected) return act(el)
    if (++tries < 30) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

/**
 * The conversation under a team doc, meeting note or task: who said what, oldest first, and the
 * box to add to it. Renders nothing for an item that takes no comments.
 */
export function Conversation({
  conversation: c,
  focusId = null,
  focusBox = 0,
  onReveal,
  dense = false,
}: ConversationProps) {
  const [showAll, setShowAll] = useState(false)
  const box = useRef<HTMLTextAreaElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  const reveal = useRef(onReveal)
  reveal.current = onReveal

  const focused = focusId !== null && c.comments.some((m) => m.id === focusId)
  // Landing on a comment: once it has loaded, bring it into view. Once per comment, however
  // often this view is swapped for the other one (the editor and the reading view each mount it).
  const { handled } = c
  useEffect(() => {
    if (!focused || handled.current.comment === focusId) return
    handled.current.comment = focusId
    reveal.current?.()
    return whenConnected(
      () => list.current?.querySelector<HTMLElement>(`[data-comment="${focusId}"]`) ?? null,
      (el) => el.scrollIntoView({ block: 'center' }),
    )
  }, [focused, focusId, handled])

  useEffect(() => {
    if (focusBox === 0 || handled.current.box === focusBox) return
    handled.current.box = focusBox
    reveal.current?.()
    return whenConnected(
      () => box.current,
      (el) => {
        el.scrollIntoView({ block: 'center' })
        el.focus({ preventScroll: true })
      },
    )
  }, [focusBox, handled])

  if (!c.canComment) {
    if (c.status === 'error' && c.offline) {
      return (
        <p data-testid="comments-offline" role="status" className="text-sm text-ink-faint">
          You’re offline. Comments need a connection.
        </p>
      )
    }
    return c.status === 'error' ? (
      <p className="text-sm text-ink-faint">
        Comments didn’t load.{' '}
        <button type="button" onClick={c.reload} className="underline hover:text-ink">
          Try again
        </button>
      </p>
    ) : null
  }

  const hidden =
    showAll || focused || c.comments.length <= COMMENTS_SHOWN
      ? 0
      : c.comments.length - COMMENTS_SHOWN
  const shown = hidden > 0 ? c.comments.slice(hidden) : c.comments
  const canSend = !c.busy && !c.offline && c.draft.text.trim() !== ''

  return (
    <section
      aria-label="Comments"
      data-testid="comments"
      className={dense ? 'space-y-3' : 'space-y-4 border-t border-ash/70 pt-6'}
    >
      <h2 className="flex items-center gap-2 text-[0.72rem] font-semibold tracking-wide text-ink-faint uppercase">
        <Icon name="chat" className="size-3.5" />
        Comments
        {c.comments.length > 0 ? (
          <span data-testid="comments-count" className="font-normal tabular-nums">
            {c.comments.length}
          </span>
        ) : null}
      </h2>

      {hidden > 0 ? (
        <button
          type="button"
          data-testid="comments-earlier"
          onClick={() => setShowAll(true)}
          className="text-sm text-ember-strong hover:underline"
        >
          Show {hidden} earlier {hidden === 1 ? 'comment' : 'comments'}
        </button>
      ) : null}

      {shown.length > 0 ? (
        <ol ref={list} className={dense ? 'space-y-3' : 'space-y-4'}>
          {shown.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              conversation={c}
              marked={comment.id === focusId}
            />
          ))}
        </ol>
      ) : null}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          void c.send()
        }}
      >
        {c.draft.quote ? (
          <div
            data-testid="comment-quote-draft"
            className="flex items-start gap-2 rounded-lg border-l-2 border-ember bg-paper-sunk/60 py-1.5 pr-1 pl-3 text-sm text-ink-soft"
          >
            <p className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap">{c.draft.quote}</p>
            <button
              type="button"
              aria-label="Remove the quote"
              title="Remove the quote"
              onClick={() => c.setDraft({ text: c.draft.text, quote: null })}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-faint hover:text-ink"
            >
              <Icon name="close" className="size-3" />
            </button>
          </div>
        ) : null}
        <Composer
          value={c.draft.text}
          onChange={(text) => c.setDraft({ text, quote: c.draft.quote })}
          onSubmit={() => void c.send()}
          members={c.members}
          readOnly={c.busy}
          placeholder="Add a comment. Type @ to mention someone."
          label="Add a comment"
          testId="comment-input"
          inputRef={box}
        />
        {c.offline ? (
          <p data-testid="comments-offline" role="status" className="text-sm text-ink-soft">
            You’re offline. Comments need a connection
            {c.draft.text.trim() ? '; your words are kept here until you’re back.' : '.'}
          </p>
        ) : null}
        {c.error ? (
          <p data-testid="comments-error" role="alert" className="text-sm text-ember-strong">
            {c.error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="comment-send"
            disabled={!canSend}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-ember px-3.5 text-sm whitespace-nowrap font-medium text-paper-raised hover:bg-ember-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {c.busy ? 'Sending…' : 'Comment'}
          </button>
          {dense ? null : (
            <span className="text-xs text-ink-faint">
              Everyone on the team can read comments. Someone you @mention gets a notification.
            </span>
          )}
        </div>
      </form>
    </section>
  )
}

function CommentItem({
  comment,
  conversation: c,
  marked,
}: {
  comment: Comment
  conversation: ConversationState
  marked: boolean
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [text, setText] = useState(comment.text)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy || !text.trim()) return
    if (text === comment.text) return setMode('view')
    setBusy(true)
    const ok = await c.edit(comment, text)
    setBusy(false)
    if (ok) setMode('view')
  }
  const remove = async () => {
    setBusy(true)
    const ok = await c.remove(comment)
    // Gone from the list when it worked; back to the comment when it didn't.
    if (!ok) {
      setBusy(false)
      setMode('view')
    }
  }

  return (
    <li
      id={`comment-${comment.id}`}
      data-comment={comment.id}
      data-testid="comment"
      {...(marked ? { 'data-marked': 'true' } : {})}
      className={`rounded-lg ${marked ? 'bg-ember-wash/60 ring-1 ring-ember/40' : ''} ${
        marked ? 'px-3 py-2' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <PersonFace
          name={comment.name}
          email={comment.author}
          className="size-5 self-center text-[0.5625rem]"
        />
        <span data-testid="comment-author" className="font-semibold text-ink">
          {comment.name || comment.author}
        </span>
        <time dateTime={comment.created} className="text-xs text-ink-faint">
          {commentWhen(comment.created)}
        </time>
        {comment.edited ? (
          <span
            data-testid="comment-edited"
            title={`Edited ${commentWhen(comment.edited)}`}
            className="text-xs text-ink-faint"
          >
            edited
          </span>
        ) : null}
        {comment.via ? <span className="text-xs text-ink-faint">via {comment.via}</span> : null}
      </div>

      {comment.quote ? (
        <blockquote
          data-testid="comment-quote"
          className="mt-1 line-clamp-4 border-l-2 border-ash-strong pl-3 text-sm whitespace-pre-wrap text-ink-soft"
        >
          {comment.quote}
        </blockquote>
      ) : null}

      {mode === 'edit' ? (
        <div className="mt-1 space-y-2">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void save()}
            onCancel={() => setMode('view')}
            members={c.members}
            readOnly={busy}
            label="Edit your comment"
            testId="comment-edit-input"
            autoFocus
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="comment-edit-save"
              disabled={busy || !text.trim()}
              onClick={() => void save()}
              className="inline-flex h-8 items-center rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setMode('view')} className={quietButton}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5">
          <CommentText comment={comment} members={c.members} />
        </div>
      )}

      {mode === 'view' && (comment.canEdit || comment.canDelete) ? (
        <div className="mt-1 flex items-center gap-3">
          {comment.canEdit ? (
            <button
              type="button"
              data-testid="comment-edit"
              onClick={() => {
                setText(comment.text)
                setMode('edit')
              }}
              className={quietButton}
            >
              Edit
            </button>
          ) : null}
          {comment.canDelete ? (
            <button
              type="button"
              data-testid="comment-delete"
              onClick={() => setMode('delete')}
              className={quietButton}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === 'delete' ? (
        <div className="mt-1 flex items-center gap-3 text-xs">
          <span className="text-ink-soft">Delete this comment?</span>
          <button
            type="button"
            data-testid="comment-delete-confirm"
            disabled={busy}
            onClick={() => void remove()}
            className="font-medium text-ember-strong hover:underline disabled:opacity-50"
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode('view')} className={quietButton}>
            Keep
          </button>
        </div>
      ) : null}
    </li>
  )
}
