// The client side of "Git is truth" for one open document.
//
// The editor holds the draft. We PUT it after `idleCommitMs` of no typing, when the user
// leaves, or on Save version. The PUT carries the blob we started from, so the server can
// three-way merge: `merged` → adopt its text in place; `conflict` (409) → open the resolver.
// Outside pushes arrive over the socket and refetch only when there are no local edits;
// otherwise the next save merges them. Unsaved drafts live in localStorage until committed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, HearthApiError } from '../api/client'
import type { CommitResult, ConflictSummary, PutFileBody } from '../api/types'
import { hearthSocket } from '../api/ws'
import type { EditorBridge } from '../components/MarkdownEditor'
import { clearDrafts, type Draft, findDraft, saveDraft } from '../lib/drafts'
import { syncTitle } from '../lib/format'
import { merge3 } from '../lib/merge3'

export const GONE_WHILE_EDITING =
  'This doc was moved or deleted while you were editing it, so your latest changes aren’t saved. They’re still here: copy them into the doc at its new place.'

export type SaveState = 'dirty' | 'saving' | 'saved' | 'committed' | 'conflict'

export interface ConflictView {
  /** Server conflict branch; null when the conflict was found client-side (edits during a merge). */
  ref: string | null
  path: string
  ours: string
  theirs: string
  theirsBlobOid: string | null
}

export interface DocumentState {
  status: 'loading' | 'ready' | 'error'
  error: HearthApiError | null
  /** Not on the server yet (created from "New doc", not saved). */
  isNew: boolean
  /** Text the editor mounts with. Replaced only on load; later server text is adopted in place. */
  initialText: string
  /** Bumps when initialText changes, so the editor can be keyed on it. */
  loadKey: number
  /** Bumps whenever the hook replaces the text (merge, refetch, restore), for read-only views. */
  revision: number
  saveState: SaveState
  lastCommittedAt: number | null
  saveError: string | null
  conflict: ConflictView | null
  /** Unresolved server conflicts for this path, shown as a banner. */
  serverConflicts: ConflictSummary[]
  /** A localStorage draft that differs from the server, offered for restore. */
  draft: Draft | null
}

export type CommitOutcome = 'committed' | 'noop' | 'conflict' | 'error'

export interface CommitOptions {
  /** Save version: names the commit (`Hearth-Label` trailer) and commits even without edits. */
  label?: string
  keepalive?: boolean
}

export interface UseDocumentOptions {
  idleCommitMs: number
  /** Opened from "New doc": a 404 means "start from the template", not "missing". */
  isNew?: boolean
  newDocText?: string
}

type DocText = { toString(): string }

const DRAFT_WRITE_DELAY_MS = 400
const RETRY_DELAY_MS = 10_000
const KEEPALIVE_LIMIT_CHARS = 60_000

const initialState = (): DocumentState => ({
  status: 'loading',
  error: null,
  isNew: false,
  initialText: '',
  loadKey: 0,
  revision: 0,
  saveState: 'committed',
  lastCommittedAt: null,
  saveError: null,
  conflict: null,
  serverConflicts: [],
  draft: null,
})

export function useDocument(space: string, path: string, options: UseDocumentOptions) {
  const [state, setState] = useState<DocumentState>(initialState)

  // Mutable working set. Refs, not state: they change on every keystroke and must be read
  // fresh inside async continuations.
  const text = useRef<DocText>('')
  /** The server version our text descends from. */
  const base = useRef<{ blobOid: string | null; content: string }>({ blobOid: null, content: '' })
  const dirty = useRef(false)
  const editSeq = useRef(0)
  const isNew = useRef(false)
  const inFlight = useRef<Promise<CommitOutcome> | null>(null)
  const conflictOpen = useRef(false)
  const refetchAfterSave = useRef(false)
  const ownCommits = useRef(new Set<string>())
  const bridge = useRef<EditorBridge | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveStateRef = useRef<SaveState>('committed')
  const mounted = useRef(true)
  const opts = useRef(options)
  opts.current = options

  const patch = useCallback((next: Partial<DocumentState>) => {
    if (!mounted.current) return
    if (next.saveState) saveStateRef.current = next.saveState
    setState((s) => ({ ...s, ...next }))
  }, [])

  const setSaveState = useCallback(
    (saveState: SaveState, extra: Partial<DocumentState> = {}) => {
      if (saveStateRef.current === saveState && Object.keys(extra).length === 0) return
      patch({ saveState, ...extra })
    },
    [patch],
  )

  /** Puts server-provided text into the editor (cursor-preserving) and our working copy. */
  const adopt = useCallback((next: string) => {
    text.current = next
    bridge.current?.setText(next)
    if (mounted.current) setState((s) => ({ ...s, revision: s.revision + 1 }))
  }, [])

  const writeDraftNow = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = null
    if (dirty.current) {
      saveDraft(space, path, base.current.blobOid ?? 'new', text.current.toString())
    }
  }, [space, path])

  const markClean = useCallback(() => {
    dirty.current = false
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = null
    clearDrafts(space, path)
  }, [space, path])

  const clearIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }, [])

  // `commit` and `refetchIfClean` call each other through these refs, avoiding a cycle of hooks.
  const commitRef = useRef<(o?: CommitOptions) => Promise<CommitOutcome>>(async () => 'noop')
  const refetchRef = useRef<() => Promise<void>>(async () => {})

  const scheduleIdleCommit = useCallback(
    (delay?: number) => {
      clearIdle()
      if (!mounted.current) return
      idleTimer.current = setTimeout(() => {
        idleTimer.current = null
        void commitRef.current()
      }, delay ?? opts.current.idleCommitMs)
    },
    [clearIdle],
  )

  const openLocalConflict = useCallback(
    (ours: string, theirs: string, theirsBlobOid: string | null, ref: string | null) => {
      conflictOpen.current = true
      writeDraftNow()
      setSaveState('conflict', {
        conflict: { ref, path, ours, theirs, theirsBlobOid },
      })
    },
    [path, setSaveState, writeDraftNow],
  )

  const handleResult = useCallback(
    (result: CommitResult, sent: string, seq: number): CommitOutcome => {
      if (result.status === 'conflict') {
        openLocalConflict(
          text.current.toString(),
          result.theirs.content,
          result.theirs.blobOid,
          result.conflictRef,
        )
        return 'conflict'
      }
      ownCommits.current.add(result.oid)
      isNew.current = false
      // The server's text differs from what we sent after a merge, or when it added an `id`.
      const serverText = result.content ?? sent
      base.current = { blobOid: result.blobOid, content: serverText }
      const editedSince = editSeq.current !== seq
      if (!editedSince) {
        if (serverText !== sent) adopt(serverText)
        markClean()
        setSaveState('committed', { lastCommittedAt: Date.now(), saveError: null, isNew: false })
        return 'committed'
      }
      // The user kept typing while the save was in flight: replay those edits on the server's text.
      if (serverText !== sent) {
        const rebased = merge3(sent, text.current.toString(), serverText)
        if (!rebased.clean) {
          openLocalConflict(text.current.toString(), serverText, result.blobOid, null)
          return 'conflict'
        }
        adopt(rebased.text)
      }
      setSaveState('dirty', { lastCommittedAt: Date.now(), saveError: null, isNew: false })
      scheduleIdleCommit()
      return 'committed'
    },
    [adopt, markClean, openLocalConflict, scheduleIdleCommit, setSaveState],
  )

  const commit = useCallback(
    async (commitOpts: CommitOptions = {}): Promise<CommitOutcome> => {
      clearIdle()
      while (inFlight.current) await inFlight.current
      if (conflictOpen.current) return 'conflict'
      const typed = text.current.toString()
      const unchanged = !dirty.current || typed === base.current.content
      if (unchanged && !commitOpts.label) {
        if (dirty.current) markClean()
        setSaveState('committed')
        return 'noop'
      }
      // A retitled heading carries frontmatter `title` with it, in the editor too.
      const sent = syncTitle(base.current.content, typed)
      if (sent !== typed) adopt(sent)
      const seq = editSeq.current
      const body: PutFileBody = {
        path,
        content: sent,
        ...(base.current.blobOid ? { baseBlobOid: base.current.blobOid } : {}),
        ...(commitOpts.label ? { label: commitOpts.label } : {}),
      }
      setSaveState('saving')
      const run = (async (): Promise<CommitOutcome> => {
        try {
          const result = await api.putFile(space, body, {
            keepalive: commitOpts.keepalive ?? false,
          })
          return handleResult(result, sent, seq)
        } catch (err) {
          // The draft is safe in localStorage; try again shortly.
          writeDraftNow()
          if (err instanceof HearthApiError && err.status === 404 && base.current.blobOid) {
            // Someone moved or deleted this doc while it was open here. Retrying can't help: say
            // so, keep the text in the editor and the browser, and let the member copy it.
            setSaveState('saved', { saveError: GONE_WHILE_EDITING })
            return 'error'
          }
          const message = err instanceof Error ? err.message : 'Save failed'
          setSaveState('saved', { saveError: message })
          scheduleIdleCommit(Math.min(RETRY_DELAY_MS, opts.current.idleCommitMs))
          return 'error'
        }
      })()
      inFlight.current = run
      const outcome = await run
      inFlight.current = null
      if (refetchAfterSave.current && !dirty.current && !conflictOpen.current) {
        refetchAfterSave.current = false
        void refetchRef.current()
      }
      return outcome
    },
    [
      space,
      path,
      adopt,
      clearIdle,
      handleResult,
      markClean,
      scheduleIdleCommit,
      setSaveState,
      writeDraftNow,
    ],
  )
  commitRef.current = commit

  const refetchIfClean = useCallback(async () => {
    if (dirty.current || inFlight.current || conflictOpen.current || isNew.current) {
      // Local edits win the race; the next save merges the outside change.
      if (inFlight.current) refetchAfterSave.current = true
      return
    }
    const seq = editSeq.current
    try {
      const file = await api.readFile(space, path)
      if (editSeq.current !== seq || dirty.current || inFlight.current) return
      if (file.blobOid === base.current.blobOid) return
      base.current = { blobOid: file.blobOid, content: file.content }
      adopt(file.content)
      setSaveState('committed')
    } catch {
      // Deleted or moved elsewhere; the tree refresh shows it. Keep the open text as is.
    }
  }, [space, path, adopt, setSaveState])
  refetchRef.current = refetchIfClean

  const loadConflicts = useCallback(async () => {
    try {
      const all = await api.conflicts(space)
      patch({ serverConflicts: all.filter((c) => c.path === path) })
    } catch {
      // The banner is a convenience; the conflict branch is safe on the server regardless.
    }
  }, [space, path, patch])

  // Load.
  useEffect(() => {
    let cancelled = false
    api.readFile(space, path).then(
      (file) => {
        if (cancelled) return
        base.current = { blobOid: file.blobOid, content: file.content }
        text.current = file.content
        const draft = findDraft(space, path)
        if (draft && draft.content === file.content) clearDrafts(space, path)
        setState((s) => ({
          ...s,
          status: 'ready',
          initialText: file.content,
          loadKey: s.loadKey + 1,
          draft: draft && draft.content !== file.content ? draft : null,
        }))
        void loadConflicts()
      },
      (err: unknown) => {
        if (cancelled) return
        const draft = findDraft(space, path)
        const startNew =
          err instanceof HearthApiError &&
          err.status === 404 &&
          (opts.current.isNew || draft?.blobOid === 'new')
        if (startNew) {
          const template = opts.current.newDocText ?? ''
          isNew.current = true
          base.current = { blobOid: null, content: template }
          text.current = template
          setState((s) => ({
            ...s,
            status: 'ready',
            isNew: true,
            initialText: template,
            loadKey: s.loadKey + 1,
            draft,
          }))
          return
        }
        const error =
          err instanceof HearthApiError ? err : new HearthApiError('internal', String(err), 0)
        setState((s) => ({ ...s, status: 'error', error }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [space, path, loadConflicts])

  // Socket events for this file.
  useEffect(() => {
    const offChanged = hearthSocket.onChanged((event) => {
      if (event.space !== space || !event.paths.includes(path)) return
      if (ownCommits.current.has(event.headOid)) return
      void refetchRef.current()
    })
    const offConflict = hearthSocket.onConflict((event) => {
      if (event.space !== space || event.path !== path) return
      setState((s) =>
        s.serverConflicts.some((c) => c.ref === event.ref) || s.conflict?.ref === event.ref
          ? s
          : {
              ...s,
              serverConflicts: [
                ...s.serverConflicts,
                { ref: event.ref, path, createdAt: new Date().toISOString() },
              ],
            },
      )
    })
    const offReconnect = hearthSocket.onReconnect(() => {
      void refetchRef.current()
      void loadConflicts()
    })
    return () => {
      offChanged()
      offConflict()
      offReconnect()
    }
  }, [space, path, loadConflicts])

  // Leaving the page: keep the draft, try a keepalive commit, and warn.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return
      writeDraftNow()
      if (text.current.toString().length < KEEPALIVE_LIMIT_CHARS) {
        void commitRef.current({ keepalive: true })
      }
      event.preventDefault()
    }
    // Phones rarely fire beforeunload; a hidden tab is the reliable "leaving" signal.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && dirty.current) void commitRef.current()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [writeDraftNow])

  // Unmount (navigating to another doc): flush whatever is still pending.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearIdle()
      if (dirty.current && !conflictOpen.current) {
        writeDraftNow()
        if (!inFlight.current) void commitRef.current()
      }
    }
  }, [clearIdle, writeDraftNow])

  const edit = useCallback(
    (next: DocText) => {
      text.current = next
      editSeq.current += 1
      dirty.current = true
      if (saveStateRef.current !== 'saving' && saveStateRef.current !== 'conflict') {
        setSaveState('dirty')
      }
      if (!draftTimer.current) draftTimer.current = setTimeout(writeDraftNow, DRAFT_WRITE_DELAY_MS)
      scheduleIdleCommit()
    },
    [scheduleIdleCommit, setSaveState, writeDraftNow],
  )

  const bindEditor = useCallback((next: EditorBridge | null) => {
    bridge.current = next
  }, [])

  const getText = useCallback(() => text.current.toString(), [])

  const openConflict = useCallback(
    async (ref: string) => {
      if (dirty.current) {
        const outcome = await commit()
        if (outcome === 'conflict') return
      }
      try {
        const detail = await api.conflict(space, ref)
        // `theirs` is null when main no longer has the file; resolving recreates it.
        openLocalConflict(
          detail.ours.content,
          detail.theirs?.content ?? '',
          detail.theirs?.blobOid ?? null,
          ref,
        )
      } catch (err) {
        patch({ saveError: err instanceof Error ? err.message : 'Could not load the conflict' })
      }
    },
    [space, commit, openLocalConflict, patch],
  )

  const resolveConflict = useCallback(
    async (content: string) => {
      const conflict = state.conflict
      if (!conflict) return
      const result = conflict.ref
        ? await api.resolveConflict(space, conflict.ref, content)
        : await api.putFile(space, {
            path,
            content,
            ...(conflict.theirsBlobOid ? { baseBlobOid: conflict.theirsBlobOid } : {}),
          })
      if (result.status === 'conflict') {
        openLocalConflict(content, result.theirs.content, result.theirs.blobOid, result.conflictRef)
        return
      }
      ownCommits.current.add(result.oid)
      const resolved = result.content ?? content
      base.current = { blobOid: result.blobOid, content: resolved }
      conflictOpen.current = false
      adopt(resolved)
      markClean()
      setState((s) => ({
        ...s,
        conflict: null,
        serverConflicts: s.serverConflicts.filter((c) => c.ref !== conflict.ref),
        saveState: 'committed',
        lastCommittedAt: Date.now(),
        saveError: null,
      }))
      saveStateRef.current = 'committed'
    },
    [space, path, state.conflict, adopt, markClean, openLocalConflict],
  )

  /**
   * Close a server conflict without resolving. "Mine" is safe on the conflict branch (and in
   * the localStorage draft), so it stops counting as unsaved: leaving the doc must not re-commit
   * it and spawn another conflict. The chip says Conflict until the banner's Resolve is used.
   */
  const dismissConflict = useCallback(() => {
    const ref = state.conflict?.ref
    if (!ref) return
    conflictOpen.current = false
    dirty.current = false
    setState((s) => ({
      ...s,
      conflict: null,
      serverConflicts: s.serverConflicts.some((c) => c.ref === ref)
        ? s.serverConflicts
        : [...s.serverConflicts, { ref, path, createdAt: new Date().toISOString() }],
    }))
  }, [state.conflict, path])

  const restoreDraft = useCallback(() => {
    const draft = state.draft
    if (!draft) return
    // Commit against the version the draft was edited from, so the server merges it forward.
    if (draft.blobOid !== 'new') base.current = { ...base.current, blobOid: draft.blobOid }
    adopt(draft.content)
    editSeq.current += 1
    dirty.current = true
    patch({ draft: null })
    setSaveState('dirty')
    scheduleIdleCommit()
  }, [state.draft, adopt, patch, scheduleIdleCommit, setSaveState])

  const discardDraft = useCallback(() => {
    clearDrafts(space, path)
    patch({ draft: null })
  }, [space, path, patch])

  const restoreVersion = useCallback(
    async (oid: string) => {
      if (dirty.current && (await commit()) === 'conflict') return
      const result = await api.restore(space, oid, path)
      if (result.status === 'conflict') {
        openLocalConflict(
          text.current.toString(),
          result.theirs.content,
          result.theirs.blobOid,
          result.conflictRef,
        )
        return
      }
      ownCommits.current.add(result.oid)
      const file = await api.readFile(space, path)
      base.current = { blobOid: file.blobOid, content: file.content }
      adopt(file.content)
      setSaveState('committed', { lastCommittedAt: Date.now() })
    },
    [space, path, commit, adopt, openLocalConflict, setSaveState],
  )

  const isDirty = useCallback(() => dirty.current, [])

  /** Re-reads the file and adopts it, unless there are local edits (they win, as for outside pushes). */
  const refetch = useCallback(() => refetchRef.current(), [])

  return useMemo(
    () => ({
      state,
      edit,
      bindEditor,
      getText,
      isDirty,
      refetch,
      commit,
      openConflict,
      resolveConflict,
      dismissConflict,
      restoreDraft,
      discardDraft,
      restoreVersion,
    }),
    [
      state,
      edit,
      bindEditor,
      getText,
      isDirty,
      refetch,
      commit,
      openConflict,
      resolveConflict,
      dismissConflict,
      restoreDraft,
      discardDraft,
      restoreVersion,
    ],
  )
}

export type DocumentHandle = ReturnType<typeof useDocument>
