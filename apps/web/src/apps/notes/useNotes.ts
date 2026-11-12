import { useCallback, useEffect, useRef, useState } from 'react'
import { HearthApiError } from '../../api/client'
import {
  type NoteLabel,
  type NoteListView,
  type NoteView,
  noteKey,
  notesApi,
} from '../../api/notes'
import { hearthSocket } from '../../api/ws'

export const REFETCH_DEBOUNCE_MS = 300

// The sidebar (in the shell) and the page (in the outlet) don't share a tree below the shell, so
// "start a new note" and "a note changed here" travel on this bus.
type BusEvent = { type: 'new-note' } | { type: 'changed' }
const listeners = new Set<(event: BusEvent) => void>()

export const notesBus = {
  emit(event: BusEvent): void {
    for (const l of listeners) l(event)
  },
  on(listener: (event: BusEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Calls `fn` (debounced) whenever a commit touches `notes/`, here or from anyone else. */
export function useNotesChanged(fn: () => void, delayMs = REFETCH_DEBOUNCE_MS): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ref.current(), delayMs)
    }
    const offSocket = hearthSocket.onChanged((event) => {
      if (event.paths.some((p) => p.startsWith('notes/'))) later()
    })
    const offBus = notesBus.on((event) => {
      if (event.type === 'changed') later()
    })
    return () => {
      clearTimeout(timer)
      offSocket()
      offBus()
    }
  }, [delayMs])
}

export function errorMessage(err: unknown): string {
  if (err instanceof HearthApiError && err.code !== 'network' && err.status < 500) {
    return err.message
  }
  return 'That didn’t save. Check your connection and try again.'
}

export interface NotesQuery {
  view: NoteListView
  label?: string | undefined
  q?: string | undefined
}

const queryKey = (q: NotesQuery) => `${q.view}\n${q.label ?? ''}\n${q.q ?? ''}`

/** The last list each query loaded, so coming back paints at once, then refreshes. */
const lastLoaded = new Map<string, NoteView[]>()

export function forgetNoteLists(): void {
  lastLoaded.clear()
  lastLabels = null
}

/**
 * The notes for a view, refetched when any note changes. `replace` and `drop` update the list
 * at once (a save's answer, or an optimistic change) without waiting for the refetch.
 */
export function useNoteList(query: NotesQuery) {
  const key = queryKey(query)
  const [notes, setNotes] = useState<NoteView[] | null>(() => lastLoaded.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef(key)
  current.current = key
  const { view, label, q } = query

  const load = useCallback(() => {
    const asked = key
    notesApi.list({ view, label, q: q?.trim() || undefined }).then(
      (list) => {
        if (current.current !== asked) return
        lastLoaded.set(asked, list)
        setNotes(list)
        setError(null)
      },
      (err) => {
        if (current.current !== asked) return
        setError(errorMessage(err))
        setNotes((prev) => prev ?? [])
      },
    )
  }, [key, view, label, q])

  useEffect(() => {
    setNotes(lastLoaded.get(key) ?? null)
    load()
  }, [key, load])
  useNotesChanged(load)

  const replace = useCallback(
    (note: NoteView) => {
      setNotes((prev) => {
        if (!prev) return prev
        const k = noteKey(note)
        const next = prev.some((n) => noteKey(n) === k)
          ? prev.map((n) => (noteKey(n) === k ? note : n))
          : [note, ...prev]
        lastLoaded.set(key, next)
        return next
      })
    },
    [key],
  )
  const drop = useCallback(
    (note: { space: string; id: string }) => {
      setNotes((prev) => {
        if (!prev) return prev
        const next = prev.filter((n) => noteKey(n) !== noteKey(note))
        lastLoaded.set(key, next)
        return next
      })
    },
    [key],
  )
  return { notes, error, reload: load, replace, drop }
}

let lastLabels: NoteLabel[] | null = null

/** Every label on the member's notes, with counts; refreshed when notes change. */
export function useNoteLabels(): NoteLabel[] {
  const [labels, setLabels] = useState<NoteLabel[]>(() => lastLabels ?? [])
  const load = useCallback(() => {
    notesApi.labels().then(
      (list) => {
        const next = Array.isArray(list) ? list : []
        lastLabels = next
        setLabels(next)
      },
      () => {},
    )
  }, [])
  useEffect(load, [load])
  useNotesChanged(load)
  return labels
}
