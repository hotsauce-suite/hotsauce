import { COMMENTS_FOLDER } from '@hotsauce/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HotsauceApiError } from '../../api/client'
import { type Comment, type CommentMember, commentsApi } from '../../api/comments'
import { hotsauceSocket } from '../../api/ws'
import { isOnline, onConnectionChange } from '../../lib/connection'
import { rememberedMember } from '../../lib/offlineStart'

const DRAFT_PREFIX = 'hotsauce.comment-draft:'

export interface CommentDraft {
  text: string
  /** The passage being commented on (docs: "Comment" on a selection). */
  quote: string | null
}

export interface Conversation {
  status: 'loading' | 'ready' | 'error'
  /** False until the server says this item takes comments. */
  canComment: boolean
  comments: Comment[]
  members: CommentMember[]
  draft: CommentDraft
  setDraft: (draft: CommentDraft) => void
  /** The browser has no connection: a comment can't be sent, and the draft is kept. */
  offline: boolean
  /**
   * What this conversation has already jumped to (the box, a linked comment). Kept here, not in
   * the view, so switching between the editor and the reading view doesn't jump again.
   */
  handled: { current: { box: number; comment: string | null } }
  /** Why the last send, edit or delete failed, in words for the member. */
  error: string | null
  busy: boolean
  send: () => Promise<boolean>
  edit: (comment: Comment, text: string) => Promise<boolean>
  remove: (comment: Comment) => Promise<boolean>
  reload: () => void
}

function readDraft(key: string): CommentDraft {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<CommentDraft> | null
    if (raw && typeof raw.text === 'string') {
      return { text: raw.text, quote: typeof raw.quote === 'string' ? raw.quote : null }
    }
  } catch {
    // Storage can be unavailable (private mode): the draft then lives for this page only.
  }
  return { text: '', quote: null }
}

function writeDraft(key: string, draft: CommentDraft): void {
  try {
    if (draft.text || draft.quote) localStorage.setItem(key, JSON.stringify(draft))
    else localStorage.removeItem(key)
  } catch {
    // Best-effort.
  }
}

// Who can be mentioned changes rarely: one fetch serves every conversation on the page.
let membersOnce: Promise<CommentMember[]> | null = null
function loadMembers(): Promise<CommentMember[]> {
  membersOnce ??= commentsApi.members().then(
    (r) => r.members,
    () => {
      membersOnce = null
      return []
    },
  )
  return membersOnce
}

/** For tests: forget the cached member list. */
export function resetCommentMembers(): void {
  membersOnce = null
}

const isOffline = () => !isOnline()

/**
 * The conversation under one item (docs/PLAN-comments.md R1 to R11). It loads on its own, after
 * the item, so the item never waits on it; it follows teammates' comments over the socket; and
 * the draft survives a reload, a lost connection and a failed send.
 */
export function useComments(space: string, path: string, enabled = true): Conversation {
  // Each member's own: on a shared computer the next member never sees what the last one typed.
  const key = `${DRAFT_PREFIX}${encodeURIComponent(rememberedMember()?.userId ?? '')}/${space}:${path}`
  const [status, setStatus] = useState<Conversation['status']>('loading')
  const [canComment, setCanComment] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [members, setMembers] = useState<CommentMember[]>([])
  const [draft, setDraftState] = useState<CommentDraft>(() => readDraft(key))
  const [offline, setOffline] = useState(isOffline)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const handled = useRef<{ box: number; comment: string | null }>({ box: 0, comment: null })
  // The item on screen, for work that finishes after the panel moved on to another one.
  const keyRef = useRef(key)
  keyRef.current = key

  // A different item (the task panel moves from task to task): start clean, with its own draft.
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setStatus('loading')
    setCanComment(false)
    setComments([])
    setError(null)
    setBusy(false)
    setDraftState(readDraft(key))
  }

  const load = useCallback(async () => {
    const turn = ++latest.current
    try {
      const view = await commentsApi.list(space, path)
      if (turn !== latest.current) return
      setCanComment(view.canComment)
      setComments(view.comments)
      setStatus('ready')
      if (view.canComment) void loadMembers().then((m) => turn === latest.current && setMembers(m))
    } catch {
      // A reload that fails keeps what is already on screen.
      if (turn === latest.current) setStatus((s) => (s === 'ready' ? s : 'error'))
    }
  }, [space, path])

  useEffect(() => {
    if (!enabled) return
    void load()
    const offChanged = hotsauceSocket.onChanged((event) => {
      if (event.space === space && event.paths.some((p) => p.startsWith(`${COMMENTS_FOLDER}/`))) {
        void load()
      }
    })
    const offReconnect = hotsauceSocket.onReconnect(() => void load())
    return () => {
      latest.current++
      offChanged()
      offReconnect()
    }
  }, [enabled, load, space])

  useEffect(() => onConnectionChange(() => setOffline(isOffline())), [])

  const setDraft = useCallback(
    (next: CommentDraft) => {
      setDraftState(next)
      writeDraft(key, next)
    },
    [key],
  )

  const fail = (err: unknown, what: string) => {
    if (err instanceof HotsauceApiError && err.code === 'network') {
      setOffline(isOffline())
      setError(`${what} needs a connection. Your words are kept here; try again in a moment.`)
    } else {
      setError(
        err instanceof Error && err.message ? err.message : `${what} didn’t work. Try again.`,
      )
    }
  }

  const send = async (): Promise<boolean> => {
    const { text, quote } = draftRef.current
    if (busy || !text.trim()) return false
    const sentFor = key
    setBusy(true)
    setError(null)
    try {
      const made = await commentsApi.add(space, path, text, quote)
      // Sent, so its draft goes, even when the panel has moved to another item meanwhile.
      writeDraft(sentFor, { text: '', quote: null })
      if (keyRef.current !== sentFor) return true
      setComments((list) => (list.some((c) => c.id === made.id) ? list : [...list, made]))
      setDraftState({ text: '', quote: null })
      return true
    } catch (err) {
      if (keyRef.current === sentFor) fail(err, 'Sending a comment')
      return false
    } finally {
      if (keyRef.current === sentFor) setBusy(false)
    }
  }

  const edit = async (comment: Comment, text: string): Promise<boolean> => {
    const editedFor = key
    setError(null)
    try {
      const saved = await commentsApi.edit(comment, text)
      if (keyRef.current !== editedFor) return true
      setComments((list) => list.map((c) => (c.id === saved.id ? saved : c)))
      return true
    } catch (err) {
      if (keyRef.current === editedFor) fail(err, 'Saving your edit')
      return false
    }
  }

  const remove = async (comment: Comment): Promise<boolean> => {
    const removedFor = key
    setError(null)
    try {
      await commentsApi.remove(comment)
      if (keyRef.current !== removedFor) return true
      setComments((list) => list.filter((c) => c.id !== comment.id))
      return true
    } catch (err) {
      if (keyRef.current === removedFor) fail(err, 'Deleting the comment')
      return false
    }
  }

  return {
    status: enabled ? status : 'loading',
    canComment: enabled && canComment,
    comments,
    members,
    draft,
    setDraft,
    offline,
    handled,
    error,
    busy,
    send,
    edit,
    remove,
    reload: () => void load(),
  }
}
