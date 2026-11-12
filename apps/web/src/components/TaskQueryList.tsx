import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { memberTimeZone, type TaskView, taskKey, tasksApi } from '../api/tasks'
import { dueWords, isOverdue, todayIn } from '../apps/tasks/logic'
import { tasksBus, useTasksChanged } from '../apps/tasks/useTaskList'
import { taskUrl } from '../lib/paths'
import { applyTaskQuery, parseTaskQuery } from '../lib/taskQuery'

export interface TaskQueryListProps {
  /** The `tasks` block's text, without its fences. */
  source: string
  /** What `space: personal` means: the member's own space. */
  personalSpace: string | null
  /** Opens a task (an in-app URL). */
  onOpen: (url: string) => void
}

const timeZone = memberTimeZone

/**
 * A live list of Hearth Tasks from a `tasks` block in a doc (docs/plans/2026-11-12-docs-task-
 * lists.md). The file keeps only the query; this refetches whenever any task changes.
 */
export function TaskQueryList({ source, personalSpace, onOpen }: TaskQueryListProps) {
  // Read again at every fetch: "due: today" must mean today even in a tab left open overnight.
  const readQuery = useCallback(() => {
    const parsed = parseTaskQuery(source, timeZone())
    if (parsed.filter.space?.toLowerCase() === 'personal' && personalSpace) {
      parsed.filter.space = personalSpace
    }
    return parsed
  }, [source, personalSpace])
  const problems = useMemo(() => readQuery().problems, [readQuery])
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const [error, setError] = useState(false)
  // Each fetch and each tick bumps this; an answer from an older fetch is dropped, so it can't
  // undo a tick shown a moment ago.
  const generation = useRef(0)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())

  const load = useCallback(() => {
    const query = readQuery()
    const mine = ++generation.current
    tasksApi.list(query.filter).then(
      (all) => {
        if (mine !== generation.current) return
        setTasks(applyTaskQuery(query, all))
        setError(false)
      },
      () => mine === generation.current && setError(true),
    )
  }, [readQuery])
  useEffect(load, [load])
  useTasksChanged(load)

  const toggle = async (task: TaskView) => {
    const key = taskKey(task)
    if (pending.has(key)) return
    generation.current++
    setPending((current) => new Set(current).add(key))
    // Shown at once; the refetch after the save settles the real state (a recurring task stays).
    setTasks(
      (current) =>
        current?.map((t) =>
          taskKey(t) === key ? { ...t, status: t.status === 'done' ? 'open' : 'done' } : t,
        ) ?? null,
    )
    try {
      if (task.status === 'done') await tasksApi.reopen(task.space, task.id)
      else await tasksApi.complete(task.space, task.id, timeZone())
    } catch {
      setError(true)
    }
    setPending((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
    tasksBus.emit({ type: 'changed' })
  }

  const now = new Date()
  const today = todayIn(timeZone(), now)
  return (
    <div data-testid="task-query" className="task-query" contentEditable={false}>
      {problems.map((problem, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines can say the same thing.
        <p key={i} className="task-query-note">
          {problem}
        </p>
      ))}
      {error ? (
        <p className="task-query-note">Tasks couldn’t load. They’ll refresh when they can.</p>
      ) : null}
      {tasks === null && !error ? <p className="task-query-empty">Loading tasks…</p> : null}
      {tasks?.length === 0 ? <p className="task-query-empty">No tasks match.</p> : null}
      {tasks && tasks.length > 0 ? (
        <ul className="task-query-list">
          {tasks.map((task) => {
            const done = task.status === 'done'
            const url = taskUrl(task.space, task.path)
            return (
              <li
                key={taskKey(task)}
                className="task-query-row"
                data-testid="task-query-row"
                data-done={done || undefined}
              >
                <input
                  type="checkbox"
                  checked={done}
                  disabled={pending.has(taskKey(task))}
                  aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
                  onChange={() => void toggle(task)}
                />
                <a
                  href={url}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return
                    event.preventDefault()
                    onOpen(url)
                  }}
                >
                  {task.title}
                </a>
                {task.due ? (
                  <span
                    className={`task-query-chip ${!done && isOverdue(task, today, now) ? 'task-query-late' : ''}`}
                  >
                    {dueWords(task.due, today, { short: true })}
                  </span>
                ) : null}
                {task.project ? <span className="task-query-chip">{task.project}</span> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
