// The client side of "Git is truth" for one open document.
//
// The editor holds the draft. We PUT it after `idleCommitMs` of no typing, when the user
// leaves, or on Save version. The PUT carries the blob we started from, so the server can
// three-way merge: `merged` → adopt its text in place; `conflict` (409) → open the resolver.
// Outside pushes arrive over the socket and refetch only when there are no local edits;
// otherwise the next save merges them. Unsaved drafts live in localStorage until committed.
// Offline (docs/PLAN-offline.md, A4), a save that can't reach the server waits in that draft,
// marked as waiting, and goes up by itself when the connection is back, even after a reload.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, HotsauceApiError } from '../api/client'
import type { CommitResult, ConflictSummary, PutFileBody } from '../api/types'
import { hotsauceSocket } from '../api/ws'
import type { EditorBridge } from '../components/MarkdownEditor'
import { isOnline, onBackOnline } from '../lib/connection'
import {
  clearDrafts,
  type Draft,
  draftKey,
  findDraft,
  markDraft,
  removeDraft,
  saveDraft,
} from '../lib/drafts'
import { syncTitle } from '../lib/format'
import { merge3 } from '../lib/merge3'
import { inOfflineSession, rememberedMember } from '../lib/offlineStart'

export const GONE_WHILE_EDITING =
  'This doc was moved or deleted while you were editing it, so your latest changes aren’t saved. They’re still here: copy them into the doc at its new place.'

/** `saved`: a save failed and is kept on this device; `offline`: the same, waiting for the
 * connection, and sent by itself when it's back. */
export type SaveState = 'dirty' | 'saving' | 'saved' | 'offline' | 'committed' | 'conflict'

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
  error: HotsauceApiError | null
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

/** `taken`: a new doc's first save found a file already at its path, so nothing was written. */
export type CommitOutcome = 'committed' | 'noop' | 'conflict' | 'error' | 'taken'

export interface CommitOptions {
  /** Save version: names the commit (`Hotsauce-Label` trailer) and commits even without edits. */
  label?: string
  keepalive?: boolean
  /**
   * A doc not on the server yet is created at this path instead of its own: it took its
   * heading's name before its first save. The caller then follows it to the new path.
   */
  createAt?: string
}

export interface UseDocumentOptions {
  idleCommitMs: number
  /** Opened from "New doc": a 404 means "start from the template", not "missing". */
  isNew?: boolean
  newDocText?: string
}

type DocText = { toString(): string }

/** A save waiting to be sent by this member (never one another member left on the device). */
function waitingHere(draft: Draft | null, owner: string | null): draft is Draft {
  return draft?.state === 'waiting' && owner !== null && draft.owner === owner
}

/** Shown when the device's storage refused the text (full, or blocked by the browser). */
export const NOT_KEPT = 'Couldn’t keep this on the device: its storage is full or blocked.'

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
  /** The server version our text descends from; `content` is null when opened offline from a
   * draft, which knows the version but not its text. */
  const base = useRef<{ blobOid: string | null; content: string | null }>({
    blobOid: null,
    content: '',
  })
  const dirty = useRef(false)
  /** A save couldn't reach the server: the draft waits for the connection (lib/drafts). */
  const waiting = useRef(false)
  /** The last draft write worked: only then does the chip say "Saved on this device". */
  const kept = useRef(true)
  /** Who's typing. Learned once and never cleared: a sign-out after a refused save (an expired
   * session) mustn't turn their waiting text into nobody's. */
  const ownerRef = useRef<string | null>(null)
  const owner = useCallback(() => {
    const id = rememberedMember()?.userId
    if (id) ownerRef.current = id
    return ownerRef.current
  }, [])
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

  /** Writes the draft now; false when the device's storage refused it. */
  const writeDraftNow = useCallback((): boolean => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = null
    if (!dirty.current) return true
    // Offline, anything typed waits to be sent, even if the tab is closed before a save runs.
    if (!isOnline() || inOfflineSession()) waiting.current = true
    kept.current = saveDraft(
      owner() ?? '',
      space,
      path,
      base.current.blobOid ?? 'new',
      text.current.toString(),
      waiting.current ? 'waiting' : 'editing',
    )
    if (waiting.current && saveStateRef.current === 'dirty' && mounted.current) {
      const next: Partial<DocumentState> = kept.current
        ? { saveState: 'offline', saveError: null }
        : { saveState: 'saved', saveError: NOT_KEPT }
      saveStateRef.current = next.saveState ?? 'dirty'
      setState((st) => ({ ...st, ...next }))
    }
    return kept.current
  }, [space, path, owner])

  /** Offline: kept on the device and waiting, or (storage refused it) only in the editor. */
  const offlineState = useCallback(
    (): Partial<DocumentState> & { saveState: SaveState } =>
      kept.current
        ? { saveState: 'offline', saveError: null }
        : { saveState: 'saved', saveError: NOT_KEPT },
    [],
  )

  const markClean = useCallback(() => {
    dirty.current = false
    waiting.current = false
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = null
    clearDrafts(owner() ?? '', space, path)
  }, [space, path, owner])

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
      // A clash is settled in the resolver (and on the server's conflict branch), never by
      // sending the same text again: the draft stays, but no longer waits to be sent.
      waiting.current = false
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
      // Offline, or started offline with no sign-in yet: keep it on this device; it goes up when
      // the connection is back (onBackOnline), or after the reload into the normal sign-in.
      if (!isOnline() || inOfflineSession()) {
        waiting.current = true
        writeDraftNow()
        const { saveState, ...extra } = offlineState()
        setSaveState(saveState, extra)
        return 'error'
      }
      // A retitled heading carries frontmatter `title` with it, in the editor too.
      const sent = syncTitle(base.current.content ?? typed, typed)
      if (sent !== typed) adopt(sent)
      const seq = editSeq.current
      // A new doc's first save creates the file, and never replaces one someone else just made.
      const creating = isNew.current
      const target = (creating && commitOpts.createAt) || path
      const body: PutFileBody = {
        path: target,
        ...(creating ? { createOnly: true } : {}),
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
          // Offline: it waits on this device and goes up when the connection is back.
          const offline = err instanceof HotsauceApiError && err.code === 'network'
          if (offline) waiting.current = true
          // The draft is safe in localStorage; try again shortly.
          writeDraftNow()
          if (
            creating &&
            commitOpts.createAt &&
            err instanceof HotsauceApiError &&
            err.status === 409
          ) {
            // The name was taken after it was picked; the caller picks another. Still unsaved.
            setSaveState('dirty')
            return 'taken'
          }
          if (err instanceof HotsauceApiError && err.status === 404 && base.current.blobOid) {
            // Someone moved or deleted this doc while it was open here. Retrying can't help: say
            // so, keep the text in the editor and the browser, and let the member copy it.
            setSaveState('saved', { saveError: GONE_WHILE_EDITING })
            return 'error'
          }
          if (offline) {
            const { saveState, ...extra } = offlineState()
            setSaveState(saveState, extra)
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
      offlineState,
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
    /**
     * Opens with a waiting draft's text (docs/PLAN-offline.md, A4.3): offline, because there's
     * nothing else on this device; online, to send it at once against the version it came from.
     */
    const openWaiting = (draft: Draft, creating: boolean, baseContent: string | null = null) => {
      isNew.current = creating
      base.current = creating
        ? { blobOid: null, content: opts.current.newDocText ?? '' }
        : { blobOid: draft.blobOid, content: baseContent }
      text.current = draft.content
      dirty.current = true
      waiting.current = true
      editSeq.current += 1
      saveStateRef.current = 'offline'
      setState((s) => ({
        ...s,
        status: 'ready',
        isNew: creating,
        initialText: draft.content,
        loadKey: s.loadKey + 1,
        saveState: 'offline',
        draft: null,
      }))
      // Kept from now on as this tab's (another tab's copy, or one from before drafts had owners).
      const stored = draftKey(owner() ?? '', space, path, base.current.blobOid ?? 'new')
      if (writeDraftNow() && draft.key !== stored) removeDraft(draft.key)
      if (isOnline() && !inOfflineSession()) void commitRef.current()
    }
    api.readFile(space, path).then(
      (file) => {
        if (cancelled) return
        const draft = findDraft(space, path, owner())
        if (
          waitingHere(draft, owner()) &&
          draft.content !== file.content &&
          draft.blobOid !== 'new'
        ) {
          openWaiting(draft, false, draft.blobOid === file.blobOid ? file.content : null)
          void loadConflicts()
          return
        }
        base.current = { blobOid: file.blobOid, content: file.content }
        text.current = file.content
        if (draft && draft.content === file.content) removeDraft(draft.key)
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
        const draft = findDraft(space, path, owner())
        // Offline with this doc's latest text on the device: open that.
        // Only this member's own: never another member's, nor an ownerless one from before.
        if (
          err instanceof HotsauceApiError &&
          err.code === 'network' &&
          draft?.owner &&
          draft.owner === owner()
        ) {
          openWaiting(draft, draft.blobOid === 'new')
          return
        }
        const startNew =
          err instanceof HotsauceApiError &&
          err.status === 404 &&
          (opts.current.isNew || draft?.blobOid === 'new')
        if (startNew && waitingHere(draft, owner()) && draft.blobOid === 'new') {
          openWaiting(draft, true)
          return
        }
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
          err instanceof HotsauceApiError ? err : new HotsauceApiError('internal', String(err), 0)
        // Moved or deleted while this member's edits waited: kept, listed under "Kept on this
        // device", and the page points there to copy them.
        if (error.status === 404 && draft?.owner) markDraft(draft.key, 'stranded')
        setState((s) => ({ ...s, status: 'error', error, draft: draft?.owner ? draft : null }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [space, path, loadConflicts, owner, writeDraftNow])

  // Back online: send what waited on this device (A4.2).
  useEffect(
    () =>
      onBackOnline(() => {
        if (dirty.current && !conflictOpen.current) void commitRef.current()
      }),
    [],
  )

  // Socket events for this file.
  useEffect(() => {
    const offChanged = hotsauceSocket.onChanged((event) => {
      if (event.space !== space || !event.paths.includes(path)) return
      if (ownCommits.current.has(event.headOid)) return
      void refetchRef.current()
    })
    const offConflict = hotsauceSocket.onConflict((event) => {
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
    const offReconnect = hotsauceSocket.onReconnect(() => {
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
      // Offline it's kept on this device and sent later: nothing to warn about, unless the
      // device refused to keep it.
      if ((!isOnline() || inOfflineSession()) && kept.current) return
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
    // Kept from now on as this tab's; the copy it came from goes once that's written.
    const stored = draftKey(owner() ?? '', space, path, base.current.blobOid ?? 'new')
    if (writeDraftNow() && draft.key !== stored) removeDraft(draft.key)
    patch({ draft: null })
    setSaveState('dirty')
    scheduleIdleCommit()
  }, [
    state.draft,
    space,
    path,
    owner,
    adopt,
    patch,
    scheduleIdleCommit,
    setSaveState,
    writeDraftNow,
  ])

  const discardDraft = useCallback(() => {
    // Only what this member was shown: never another member's or another tab's waiting text.
    if (state.draft) removeDraft(state.draft.key)
    clearDrafts(owner() ?? '', space, path)
    patch({ draft: null })
  }, [state.draft, space, path, owner, patch])

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

  /**
   * Saves a doc not on the server yet under `to` instead of its own path. `not-new` when it has
   * been saved in the meantime (an idle save got there first): the caller moves it instead.
   */
  const createAt = useCallback(
    async (to: string): Promise<CommitOutcome | 'not-new'> => {
      while (inFlight.current) await inFlight.current
      if (!isNew.current) return 'not-new'
      return commit({ createAt: to })
    },
    [commit],
  )

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
      createAt,
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
      createAt,
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
