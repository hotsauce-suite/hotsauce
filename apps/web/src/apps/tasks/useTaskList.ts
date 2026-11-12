import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HearthApiError } from '../../api/client'
import { type TaskView, taskKey, tasksApi } from '../../api/tasks'
import { hearthSocket } from '../../api/ws'
import { belongs, sortTasks, type TaskViewSpec, viewQuery } from './logic'

export const REFETCH_DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------------------------
// A tiny in-page bus: the sidebar (in the shell) and the page (in the outlet) don't share a
// React tree below the shell, so "open quick add" and "a task changed here" travel this way.

type BusEvent = { type: 'quick-add' } | { type: 'changed' }
const listeners = new Set<(event: BusEvent) => void>()

export const tasksBus = {
  emit(event: BusEvent): void {
    for (const l of listeners) l(event)
  },
  on(listener: (event: BusEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** Calls `fn` (debounced) whenever a commit touches `tasks/`, here or from anyone else. */
export function useTasksChanged(fn: () => void, delayMs = REFETCH_DEBOUNCE_MS): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ref.current(), delayMs)
    }
    const offSocket = hearthSocket.onChanged((event) => {
      if (event.paths.some((p) => p.startsWith('tasks/'))) later()
    })
    const offBus = tasksBus.on((event) => {
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
  if (err instanceof HearthApiError && err.code !== 'network' && err.status < 500)
    return err.message
  return 'That didn’t save. Check your connection and try again.'
}

// ---------------------------------------------------------------------------------------------

/** The last list each view loaded, so coming back to a view paints at once, then refreshes. */
const lastLoaded = new Map<string, TaskView[]>()

/** Forgets the cached lists (tests, sign-out). */
export function forgetTaskLists(): void {
  lastLoaded.clear()
}

interface Override {
  /** What the task looks like until the server answers; null while it's leaving the list. */
  task: TaskView | null
  seq: number
}

export interface TaskList {
  /** Null until the first load. */
  tasks: TaskView[] | null
  error: string | null
  reload: () => void
  /**
   * Shows `optimistic` (null hides the task) at once, runs `run`, then adopts its answer. On a
   * failure the list goes back to what the server last said and `onError` hears why.
   */
  mutate: (
    key: string,
    optimistic: TaskView | null,
    run: () => Promise<TaskView | null>,
  ) => Promise<TaskView | null>
  /** Adopts a task the server returned (a new one, or one changed elsewhere on the page). */
  adopt: (task: TaskView) => void
  /** Every task the list knows, before the view's filter: for looking one up by key. */
  find: (key: string) => TaskView | undefined
}

/**
 * One view's tasks: loaded with the view's query, refetched (debounced) on any `tasks/` change,
 * with optimistic changes layered over the server's list until their request settles, so a
 * refetch never discards a change still in flight.
 */
export function useTaskList(
  view: TaskViewSpec,
  opts: { today: string; now: Date; onError: (message: string) => void },
): TaskList {
  const viewKey = JSON.stringify(view)
  const [server, setServerState] = useState<TaskView[] | null>(
    () => lastLoaded.get(viewKey) ?? null,
  )
  const setServer = useCallback(
    (next: TaskView[] | null | ((list: TaskView[] | null) => TaskView[] | null)) => {
      setServerState((list) => {
        const value = typeof next === 'function' ? next(list) : next
        if (value) lastLoaded.set(viewKey, value)
        return value
      })
    },
    [viewKey],
  )
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const generation = useRef(0)
  const { today, now } = opts
  const onError = useRef(opts.onError)
  onError.current = opts.onError

  const load = useCallback(() => {
    const spec = JSON.parse(viewKey) as TaskViewSpec
    const gen = ++generation.current
    tasksApi.list(viewQuery(spec, new Date(), today)).then(
      (list) => {
        if (gen !== generation.current) return
        setServer(list)
        setError(null)
      },
      (err: unknown) => {
        if (gen !== generation.current) return
        setServer((s) => s ?? [])
        setError(err instanceof Error ? err.message : 'Couldn’t load tasks')
      },
    )
  }, [viewKey, today, setServer])

  useEffect(() => {
    setServer(lastLoaded.get(viewKey) ?? null)
    load()
  }, [load, viewKey, setServer])

  useTasksChanged(load)

  const upsert = useCallback(
    (key: string, task: TaskView | null) => {
      setServer((list) => {
        const current = list ?? []
        const rest = current.filter((t) => taskKey(t) !== key)
        if (!task) return rest
        const at = current.findIndex((t) => taskKey(t) === key)
        if (at === -1) return [...rest, task]
        const next = [...current]
        next[at] = task
        return next
      })
    },
    [setServer],
  )

  const clearOverride = useCallback((key: string, mine: number) => {
    setOverrides((map) => {
      if (map.get(key)?.seq !== mine) return map
      const next = new Map(map)
      next.delete(key)
      return next
    })
  }, [])

  const mutate = useCallback<TaskList['mutate']>(
    async (key, optimistic, run) => {
      seq.current += 1
      const mine = seq.current
      setOverrides((map) => new Map(map).set(key, { task: optimistic, seq: mine }))
      try {
        const result = await run()
        // A load sent before this change settled would put the old task back: drop it. The
        // `changed` below reloads.
        generation.current += 1
        upsert(key, result)
        if (result && taskKey(result) !== key) upsert(taskKey(result), result)
        clearOverride(key, mine)
        tasksBus.emit({ type: 'changed' })
        return result
      } catch (err) {
        clearOverride(key, mine)
        onError.current(errorMessage(err))
        throw err
      }
    },
    [upsert, clearOverride],
  )

  const adopt = useCallback((task: TaskView) => upsert(taskKey(task), task), [upsert])

  const merged = useMemo(() => {
    if (server === null) return null
    const byKey = new Map(server.map((t) => [taskKey(t), t] as const))
    for (const [key, o] of overrides) {
      if (o.task) byKey.set(key, o.task)
      else byKey.delete(key)
    }
    return [...byKey.values()]
  }, [server, overrides])

  const tasks = useMemo(() => {
    if (merged === null) return null
    const spec = JSON.parse(viewKey) as TaskViewSpec
    return sortTasks(
      spec,
      merged.filter((t) => belongs(spec, t, today, now)),
    )
  }, [merged, viewKey, today, now])

  const find = useCallback((key: string) => merged?.find((t) => taskKey(t) === key), [merged])

  return { tasks, error, reload: load, mutate, adopt, find }
}
