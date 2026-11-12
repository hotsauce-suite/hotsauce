import { addDays } from '@hearth/format'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useMatches, useNavigate, useParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import {
  memberTimeZone,
  type Priority,
  type TaskPatch,
  type TaskView,
  taskKey,
  tasksApi,
} from '../../api/tasks'
import { product } from '../../brand/product'
import { useShell } from '../../components/AppShell'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { useNow } from '../meetings/components/RecordingIndicator'
import { FromMeetings } from './FromMeetings'
import {
  completedCopy,
  dayDetail,
  groupTasks,
  homeViewOf,
  isReorderable,
  itemUrl,
  orderForMove,
  type TaskViewSpec,
  todayIn,
  viewUrl,
  withPatch,
} from './logic'
import { QuickAdd } from './QuickAdd'
import type { TasksRouteKind } from './routes'
import { TaskDetail } from './TaskDetail'
import { TaskList } from './TaskList'
import { TaskRow } from './TaskRow'
import { errorMessage, tasksBus, useTaskList, useTasksChanged } from './useTaskList'
import { usePeople, useProjects, useTaskSpaces } from './useTaskMeta'

/** How long a completed row takes to slide out before the list drops it. */
export const LEAVE_MS = 260
/** How long Undo is offered after completing a task. */
export const UNDO_MS = 5000

interface Toast {
  id: number
  message: string
  undo?: () => void
}

const TITLES: Record<Exclude<TaskViewSpec['id'], 'project'>, string> = {
  inbox: 'Inbox',
  today: 'Today',
  upcoming: 'Upcoming',
  all: 'All tasks',
  done: 'Done',
}

const EMPTY: Record<TaskViewSpec['id'], string> = {
  inbox: 'Your inbox is clear. Add a task, or press q.',
  today: 'Nothing due today.',
  upcoming: 'Nothing scheduled for the next two weeks.',
  all: 'No open tasks anywhere.',
  done: 'Nothing done in the last 30 days yet.',
  project: 'No open tasks in this project.',
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit'].includes(target.type)
  }
  return false
}

function useRouteKind(): TasksRouteKind {
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle as { tasksKind?: TasksRouteKind } | undefined
    if (handle?.tasksKind) return handle.tasksKind
  }
  return 'inbox'
}

/** Every list of Hearth Tasks, with quick add, the detail panel, shortcuts and Undo. */
export default function TasksPage() {
  const kind = useRouteKind()
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const session = useSession()
  const { compact } = useShell()
  const tz = useMemo(memberTimeZone, [])
  const nowMs = useNow(60_000)
  const now = useMemo(() => new Date(nowMs), [nowMs])
  const today = todayIn(tz, now)
  const me = session.me?.principal.email
  const spaces = useTaskSpaces()
  const people = usePeople()
  const projects = useProjects()
  const notify = session.notify

  useEffect(() => {
    document.title = `${product()} Tasks`
  }, [])

  // The open task (item route), and the list it shows in.
  const itemKey =
    kind === 'item' && params.space && params.id ? `${params.space}/${params.id}` : null
  const fromState = (location.state as { from?: TaskViewSpec } | null)?.from
  const [fetched, setFetched] = useState<TaskView | null>(null)
  const [itemView, setItemView] = useState<TaskViewSpec | null>(fromState ?? null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (fromState) setItemView(fromState)
  }, [fromState])

  useEffect(() => {
    if (!itemKey || !params.space || !params.id) {
      setFetched(null)
      setMissing(false)
      return
    }
    let live = true
    tasksApi.get(params.space, params.id).then(
      (task) => {
        if (!live) return
        setFetched(task)
        setMissing(false)
        setItemView((v) => v ?? homeViewOf(task, todayIn(tz)))
      },
      (err: unknown) => {
        if (!live) return
        setMissing(true)
        setItemView((v) => v ?? { id: 'inbox' })
        if (!(err instanceof HearthApiError && err.status === 404)) notify(errorMessage(err))
      },
    )
    return () => {
      live = false
    }
  }, [itemKey, params.space, params.id, tz, notify])

  const view: TaskViewSpec = useMemo(() => {
    if (kind === 'item') return itemView ?? { id: 'inbox' }
    if (kind === 'project')
      return { id: 'project', space: params.space ?? '', project: params.name ?? '' }
    return { id: kind }
  }, [kind, itemView, params.space, params.name])

  const list = useTaskList(view, { today, now, onError: notify })
  // For timers that fire after the view may have changed: write into the list shown then.
  const listRef = useRef(list)
  listRef.current = list
  const tasks = list.tasks
  const groups = useMemo(() => (tasks ? groupTasks(view, tasks, today) : []), [tasks, view, today])
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups])

  const detail = itemKey ? (list.find(itemKey) ?? fetched) : null
  const detailKey = detail ? taskKey(detail) : null

  // ---------------------------------------------------------------------------- state
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [quickOpen, setQuickOpen] = useState(false)
  // The `e` shortcut: which task's title to focus, and a counter so pressing it again refocuses.
  const [focusTitle, setFocusTitle] = useState<{ key: string; n: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<TaskView | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (detailKey) setSelectedKey(detailKey)
    // Opening another task (or closing this one) forgets a pending focus.
    setFocusTitle((f) => (f && f.key === detailKey ? f : null))
  }, [detailKey])

  useEffect(() => tasksBus.on((e) => e.type === 'quick-add' && setQuickOpen(true)), [])
  useEffect(() => {
    if ((location.state as { quickAdd?: boolean } | null)?.quickAdd) setQuickOpen(true)
  }, [location.state])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const showToast = useCallback((t: Omit<Toast, 'id'>) => {
    clearTimeout(toastTimer.current)
    const id = Date.now()
    setToast({ ...t, id })
    toastTimer.current = setTimeout(() => setToast((c) => (c?.id === id ? null : c)), UNDO_MS)
  }, [])

  // -------------------------------------------------------------------------- actions
  const openTask = (task: TaskView) => navigate(itemUrl(task), { state: { from: view } })
  const closeDetail = () => navigate(viewUrl(view))

  const patch = (task: TaskView, change: TaskPatch) => {
    const key = taskKey(task)
    list
      .mutate(key, withPatch(task, change, tz), () => tasksApi.update(task.space, task.id, change))
      .then(
        (result) => {
          if (result && fetched && taskKey(result) === taskKey(fetched)) setFetched(result)
        },
        (err: unknown) => {
          // Someone changed the title or notes being overwritten: show theirs.
          if (err instanceof HearthApiError && err.status === 409) {
            tasksApi.get(task.space, task.id).then(list.adopt, () => {})
          }
        },
      )
  }

  const toggle = (task: TaskView) => {
    const key = taskKey(task)
    if (task.status === 'done') {
      list
        .mutate(key, { ...task, status: 'open', completed: null, completedBy: null }, () =>
          tasksApi.reopen(task.space, task.id),
        )
        .catch(() => {})
      return
    }
    if (leaving.has(key)) return
    setLeaving((s) => new Set(s).add(key))
    const pending = new Promise<TaskView | null>((resolve) => {
      setTimeout(() => {
        setLeaving((s) => {
          const next = new Set(s)
          next.delete(key)
          return next
        })
        listRef.current
          .mutate(key, completedCopy(task, today, new Date()), () =>
            tasksApi.complete(task.space, task.id, tz),
          )
          .then(resolve, () => resolve(null))
      }, LEAVE_MS)
    })
    showToast({
      message: task.recur ? `“${task.title}” moved to its next date` : `Completed “${task.title}”`,
      undo: () => {
        setToast(null)
        void pending.then((done) => {
          if (!done) return
          const run = task.recur
            ? () =>
                tasksApi.update(
                  task.space,
                  task.id,
                  task.due ? { due: task.due, ...(task.tz ? { tz: task.tz } : {}) } : { due: null },
                )
            : () => tasksApi.reopen(task.space, task.id)
          listRef.current.mutate(key, task, run).catch(() => {})
        })
      },
    })
  }

  const remove = (task: TaskView) => {
    setConfirmDelete(null)
    const key = taskKey(task)
    if (key === detailKey) closeDetail()
    list
      .mutate(key, null, async () => {
        await tasksApi.remove(task.space, task.id)
        return null
      })
      .then(() => showToast({ message: `Deleted “${task.title}”` }))
      .catch(() => {})
  }

  const move = (task: TaskView, toSpace: string) => {
    list
      .mutate(taskKey(task), { ...task, space: toSpace }, () =>
        tasksApi.move(task.space, task.id, toSpace),
      )
      .then((result) => {
        if (result) {
          setFetched(result)
          navigate(itemUrl(result), { replace: true, state: { from: view } })
        }
      })
      .catch(() => {})
  }

  const reorder = (from: number, to: number) => {
    const task = flat[from]
    const order = orderForMove(flat, from, to)
    if (!task || order === null) return
    patch(task, { order })
  }

  const added = (task: TaskView) => {
    list.adopt(task)
    setSelectedKey(taskKey(task))
    tasksBus.emit({ type: 'changed' })
  }

  // ------------------------------------------------------------------------ shortcuts
  const keyState = useRef({ flat, selectedKey, detail })
  keyState.current = { flat, selectedKey, detail }
  const actions = useRef({ toggle, patch, openTask, setConfirmDelete, today })
  actions.current = { toggle, patch, openTask, setConfirmDelete, today }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event.target)) return
      // Enter and Space on a focused button or link do what that control does.
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        event.target instanceof Element &&
        event.target.closest('button, a, [role="checkbox"]')
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      const { flat: rows, selectedKey: sel, detail: open } = keyState.current
      const a = actions.current
      const index = rows.findIndex((t) => taskKey(t) === sel)
      const selected = rows[index] ?? (open && taskKey(open) === sel ? open : undefined)
      const select = (i: number) => {
        const t = rows[Math.max(0, Math.min(rows.length - 1, i))]
        if (!t) return
        setSelectedKey(taskKey(t))
        document
          .querySelector(`[data-testid="task-row"][data-key="${CSS.escape(taskKey(t))}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
      const key = event.key
      let handled = true
      if (key === 'q') setQuickOpen(true)
      else if (key === 'j' || key === 'ArrowDown') select(index === -1 ? 0 : index + 1)
      else if (key === 'k' || key === 'ArrowUp') select(index === -1 ? 0 : index - 1)
      else if (!selected) handled = false
      else if (key === 'x' || key === ' ') a.toggle(selected)
      else if (key === 'Enter') a.openTask(selected)
      else if (key === 'e') {
        a.openTask(selected)
        const k = taskKey(selected)
        setFocusTitle((f) => ({ key: k, n: (f?.n ?? 0) + 1 }))
      } else if (key === 'Delete' || key === 'Backspace') a.setConfirmDelete(selected)
      else if (key >= '1' && key <= '4') {
        const p = Number(key) as Priority
        if (p !== selected.priority) a.patch(selected, { priority: p })
      } else if (key === 't' || key === 'm') {
        const date = key === 't' ? a.today : addDays(a.today, 1)
        const time = selected.due && selected.due.length > 10 ? selected.due.slice(10) : ''
        // A timed task keeps its own zone (a PATCH's tz is otherwise the member's).
        a.patch(selected, { due: date + time, ...(time && selected.tz ? { tz: selected.tz } : {}) })
      } else handled = false
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --------------------------------------------------------------------------- render
  const title =
    view.id === 'project' ? view.project : TITLES[view.id as Exclude<TaskViewSpec['id'], 'project'>]
  const projectNames = useMemo(
    () =>
      [...new Set(projects.filter((p) => p.space === detail?.space).map((p) => p.name))].sort(
        (x, y) => x.localeCompare(y),
      ),
    [projects, detail?.space],
  )
  const defaultSpace = view.id === 'project' && view.space === spaces.team ? 'team' : 'personal'
  const reorderable = isReorderable(view)
  const open = tasks?.length ?? 0

  return (
    <>
      <MeetingsPageHeader title={`${product()} Tasks`}>
        <button
          type="button"
          data-testid="tasks-add"
          onClick={() => setQuickOpen(true)}
          className={`${primaryButton} h-9 px-3`}
        >
          <Icon name="plus" />
          <span className="hidden sm:inline">Add task</span>
          <span className="sm:hidden">Add</span>
        </button>
      </MeetingsPageHeader>
      <div className="flex min-h-0 flex-1">
        <div
          data-testid="tasks-page"
          data-view={view.id}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-28 md:px-8 md:pt-10">
            <div className="mb-4 flex items-baseline gap-3">
              <h1
                data-testid="tasks-title"
                className="min-w-0 truncate font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-ink"
              >
                {view.id === 'project' ? (
                  <>
                    <span className="mr-1 text-ink-faint">#</span>
                    {title}
                  </>
                ) : (
                  title
                )}
              </h1>
              <span className="shrink-0 text-sm text-ink-faint">
                {view.id === 'today'
                  ? dayDetail(today)
                  : view.id === 'project'
                    ? session.spaceLabel(view.space)
                    : tasks && open > 0 && view.id !== 'done'
                      ? `${open} open`
                      : ''}
              </span>
            </div>

            {view.id !== 'done' ? (
              <div className="mb-5">
                <QuickAdd
                  key={viewUrl(view)}
                  today={today}
                  tz={tz}
                  me={me}
                  people={people}
                  spaces={spaces}
                  defaultSpace={defaultSpace}
                  defaultProject={view.id === 'project' ? view.project : undefined}
                  dueTodayByDefault={view.id === 'today'}
                  open={quickOpen}
                  onOpenChange={setQuickOpen}
                  onAdded={added}
                  onError={notify}
                />
              </div>
            ) : null}

            {list.error && tasks?.length === 0 ? (
              <p role="alert" className="mb-4 text-sm text-ember-strong">
                {list.error}
              </p>
            ) : null}

            {tasks === null ? (
              <div aria-hidden="true" className="space-y-2" data-testid="tasks-loading">
                {[0, 1, 2].map((n) => (
                  <div key={n} className="h-12 rounded-xl bg-paper-sunk/60" />
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <p data-testid="tasks-empty" className="px-1 py-6 text-[0.95rem] text-ink-soft">
                {missing ? 'That task isn’t here any more.' : EMPTY[view.id]}
              </p>
            ) : (
              <div className="space-y-6">
                {groups.map((group) =>
                  group.tasks.length === 0 && group.key === 'today' ? null : (
                    <section
                      key={group.key}
                      aria-label={group.title || title}
                      data-testid="task-group"
                      data-group={group.key}
                    >
                      {group.title ? (
                        <h2
                          className={`mb-1.5 flex items-baseline gap-2 px-1 text-xs font-semibold tracking-wide uppercase ${group.overdue ? 'text-ember-strong' : 'text-ink-faint'}`}
                        >
                          {group.title}
                          {group.detail ? (
                            <span className="font-normal tracking-normal normal-case">
                              {group.detail}
                            </span>
                          ) : null}
                          <span className="ml-auto font-normal tracking-normal">
                            {group.tasks.length}
                          </span>
                        </h2>
                      ) : null}
                      <TaskList
                        label={group.title || title}
                        tasks={group.tasks}
                        today={today}
                        now={now}
                        selectedKey={selectedKey}
                        leaving={leaving}
                        showProject={view.id !== 'project'}
                        people={people}
                        onToggle={toggle}
                        onOpen={openTask}
                        onSelect={(t) => setSelectedKey(taskKey(t))}
                        onReorder={reorderable ? reorder : undefined}
                      />
                    </section>
                  ),
                )}
              </div>
            )}

            {view.id === 'today' ? (
              <FromMeetings today={today} tz={tz} onAdded={added} onError={notify} />
            ) : null}

            {view.id === 'project' ? (
              <ProjectDone
                space={view.space}
                project={view.project}
                today={today}
                now={now}
                onOpen={openTask}
                onError={notify}
              />
            ) : null}

            <p className="mt-10 hidden text-[0.72rem] text-ink-faint md:block">
              q add · j/k move · x complete · Enter open · e edit · 1–4 priority · t today · m
              tomorrow · Delete
            </p>
          </div>
        </div>

        {detail ? (
          <TaskDetail
            key={detailKey}
            task={detail}
            today={today}
            tz={tz}
            me={me}
            people={people}
            projectNames={projectNames}
            spaces={spaces}
            compact={compact}
            focusTitle={focusTitle && focusTitle.key === detailKey ? focusTitle.n : 0}
            onPatch={(change) => patch(detail, change)}
            onToggle={() => toggle(detail)}
            onMove={(toSpace) => move(detail, toSpace)}
            onDelete={() => setConfirmDelete(detail)}
            onClose={closeDetail}
          />
        ) : null}
      </div>

      {confirmDelete ? (
        <Dialog
          title="Delete this task?"
          onClose={() => setConfirmDelete(null)}
          testId="task-delete-dialog"
        >
          <p className="text-sm text-ink-soft">
            “{confirmDelete.title}” goes to the space’s trash. Its history stays in Git.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="task-delete-confirm"
              className={`${primaryButton} h-9`}
              onClick={() => remove(confirmDelete)}
            >
              Delete
            </button>
          </div>
        </Dialog>
      ) : null}

      {toast ? (
        <div
          role="status"
          data-testid="task-toast"
          className={`task-toast fixed left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-lg border border-ash bg-paper-raised px-4 py-2.5 text-sm text-ink shadow-float ${compact ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'bottom-6'}`}
        >
          <span className="min-w-0 truncate">{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              data-testid="task-undo"
              onClick={toast.undo}
              className="shrink-0 font-semibold text-ember-strong hover:underline"
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** A project's done tasks, collapsed until asked for. */
function ProjectDone({
  space,
  project,
  today,
  now,
  onOpen,
  onError,
}: {
  space: string
  project: string
  today: string
  now: Date
  onOpen: (task: TaskView) => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const people = usePeople()
  const load = useCallback(() => {
    tasksApi.list({ status: 'done', space, project, limit: 100 }).then(setTasks, () => setTasks([]))
  }, [space, project])

  useEffect(() => {
    setTasks(null)
    if (open) load()
  }, [open, load])
  useTasksChanged(() => {
    if (open) load()
  })

  const reopen = (task: TaskView) => {
    setTasks((list) => list?.filter((t) => taskKey(t) !== taskKey(task)) ?? null)
    tasksApi.reopen(task.space, task.id).then(
      () => tasksBus.emit({ type: 'changed' }),
      (err: unknown) => {
        onError(errorMessage(err))
        load()
      },
    )
  }

  return (
    <section className="mt-8" data-testid="project-done">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-1 text-xs font-semibold tracking-wide text-ink-faint uppercase hover:text-ink-soft"
      >
        <Icon name="chevron" className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        Done
      </button>
      {open ? (
        tasks === null ? null : tasks.length === 0 ? (
          <p className="mt-2 px-1 text-sm text-ink-faint">Nothing done here yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/30">
            {tasks.map((task) => (
              <TaskRow
                key={taskKey(task)}
                task={task}
                today={today}
                now={now}
                selected={false}
                leaving={false}
                showProject={false}
                people={people}
                onToggle={() => reopen(task)}
                onOpen={() => onOpen(task)}
                onSelect={() => {}}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
