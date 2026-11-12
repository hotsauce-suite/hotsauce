// The pure parts of the Tasks views (ARCHITECTURE §12.5): which tasks a view shows, in what
// order and groups, how a due value reads, and the order a dragged task lands on. Dates are the
// member's wall-clock dates (`localNow`), never the browser's UTC day.

import {
  addDays,
  dueDate,
  dueInstant,
  isTimed,
  localNow,
  nextDue,
  type ParsedTask,
  weekday,
} from '@hearth/format'
import type { TaskFilter, TaskPatch, TaskView } from '../../api/tasks'

export type ViewId = 'inbox' | 'today' | 'upcoming' | 'all' | 'project' | 'done'

export type TaskViewSpec =
  | { id: 'inbox' | 'today' | 'upcoming' | 'all' | 'done' }
  | { id: 'project'; space: string; project: string }

export const UPCOMING_DAYS = 14
export const DONE_DAYS = 30

/** Today's date in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return localNow(now, timeZone).date
}

/** The `GET /api/tasks` query a view loads. */
export function viewQuery(view: TaskViewSpec, now: Date, today: string): TaskFilter {
  switch (view.id) {
    // Filtered on the server, so the list's limit applies to what the view shows.
    case 'inbox':
      return { mine: true, status: 'open', project: '' }
    case 'today':
      return { mine: true, status: 'open', dueBefore: today }
    case 'upcoming':
      return { mine: true, status: 'open', dueAfter: today }
    // Every open task the member can see: theirs, and the team's assigned to anyone.
    case 'all':
      return { mine: false, status: 'open' }
    case 'done':
      return {
        mine: true,
        status: 'done',
        doneSince: new Date(now.getTime() - DONE_DAYS * 86_400_000).toISOString(),
      }
    case 'project':
      return { status: 'open', space: view.space, project: view.project }
  }
}

/** Whether `task` is one `view` shows; applied to every list, after optimistic changes too. */
export function belongs(view: TaskViewSpec, task: TaskView, today: string, now: Date): boolean {
  switch (view.id) {
    case 'inbox':
      return task.mine && task.status === 'open' && !task.project
    case 'today':
      return task.mine && task.status === 'open' && !!task.due && dueDate(task.due) <= today
    case 'upcoming':
      return task.mine && task.status === 'open' && !!task.due && dueDate(task.due) >= today
    case 'all':
      return task.status === 'open'
    case 'done': {
      if (!task.mine || task.status !== 'done') return false
      const since = now.getTime() - DONE_DAYS * 86_400_000
      return !task.completed || Date.parse(task.completed) >= since
    }
    case 'project':
      return task.status === 'open' && task.space === view.space && task.project === view.project
  }
}

/** Lists the member orders by hand (drag to reorder). */
export function isReorderable(view: TaskViewSpec): boolean {
  return view.id === 'inbox' || view.id === 'project'
}

/**
 * Where a task sits in a hand-ordered list. A task never moved has no `order`; it sits by when it
 * was made (seconds since 1970), so new tasks land at the bottom and a dragged task can go
 * between two that were never moved.
 */
export function effectiveOrder(task: Pick<TaskView, 'order' | 'created'>): number {
  if (typeof task.order === 'number') return task.order
  const created = Date.parse(task.created)
  return Number.isFinite(created) ? created / 1000 : Number.MAX_SAFE_INTEGER
}

const ORDER_STEP = 1024

/**
 * The `order` for the task at `from` dropped at `to` (indexes into `list` as shown): the midpoint
 * of its new neighbors, or a step past the end it lands on. Null when it didn't move.
 */
export function orderForMove(
  list: ReadonlyArray<Pick<TaskView, 'order' | 'created'>>,
  from: number,
  to: number,
): number | null {
  if (from === to || from < 0 || from >= list.length) return null
  const rest = list.filter((_, i) => i !== from)
  const at = Math.max(0, Math.min(to, rest.length))
  const prev = rest[at - 1]
  const next = rest[at]
  if (prev && next) return (effectiveOrder(prev) + effectiveOrder(next)) / 2
  if (next) return effectiveOrder(next) - ORDER_STEP
  if (prev) return effectiveOrder(prev) + ORDER_STEP
  return null
}

/**
 * Where a dragged row would land: the number of other rows whose middle is above the dragged
 * row's middle. `mids` are the rows' vertical middles when the drag began.
 */
export function dropIndex(mids: readonly number[], from: number, center: number): number {
  let to = 0
  mids.forEach((mid, i) => {
    if (i !== from && mid < center) to += 1
  })
  return to
}

const byCreated = (a: TaskView, b: TaskView) => a.created.localeCompare(b.created)

/** The server's order for open tasks: due (dates before times), priority, order, created. */
function byDue(a: TaskView, b: TaskView): number {
  if (a.due !== b.due) {
    if (!a.due) return 1
    if (!b.due) return -1
    const da = dueDate(a.due)
    const db = dueDate(b.due)
    if (da !== db) return da < db ? -1 : 1
    if (a.due.length !== b.due.length) return a.due.length - b.due.length
    return a.due < b.due ? -1 : 1
  }
  if (a.priority !== b.priority) return a.priority - b.priority
  if (a.order !== b.order) {
    if (a.order === null) return 1
    if (b.order === null) return -1
    return a.order - b.order
  }
  return byCreated(a, b)
}

export function sortTasks(view: TaskViewSpec, tasks: TaskView[]): TaskView[] {
  const list = [...tasks]
  if (view.id === 'done') {
    return list.sort((a, b) => (b.completed ?? '').localeCompare(a.completed ?? ''))
  }
  if (isReorderable(view)) {
    return list.sort((a, b) => effectiveOrder(a) - effectiveOrder(b) || byCreated(a, b))
  }
  return list.sort(byDue)
}

export interface TaskGroup {
  key: string
  title: string
  /** Shown after the title, quieter: "Wed Nov 11". */
  detail?: string
  tasks: TaskView[]
  overdue?: boolean
}

/** Groups a sorted list: Today splits off Overdue; Upcoming is by day for 14 days, then Later. */
export function groupTasks(view: TaskViewSpec, tasks: TaskView[], today: string): TaskGroup[] {
  if (view.id === 'today') {
    const overdue = tasks.filter((t) => t.due && dueDate(t.due) < today)
    const due = tasks.filter((t) => !t.due || dueDate(t.due) >= today)
    const groups: TaskGroup[] = []
    if (overdue.length > 0)
      groups.push({ key: 'overdue', title: 'Overdue', tasks: overdue, overdue: true })
    groups.push({ key: 'today', title: 'Today', detail: dayDetail(today), tasks: due })
    return groups
  }
  if (view.id === 'upcoming') {
    const end = addDays(today, UPCOMING_DAYS)
    const days = new Map<string, TaskView[]>()
    const later: TaskView[] = []
    for (const t of tasks) {
      if (!t.due) continue
      const d = dueDate(t.due)
      if (d >= end) later.push(t)
      else days.set(d, [...(days.get(d) ?? []), t])
    }
    const groups: TaskGroup[] = [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([d, list]) => {
        const words = relativeDay(d, today)
        return {
          key: d,
          title: words ?? dayDetail(d),
          ...(words ? { detail: dayDetail(d) } : {}),
          tasks: list,
        }
      })
    if (later.length > 0) groups.push({ key: 'later', title: 'Later', tasks: later })
    return groups
  }
  if (view.id === 'all') {
    const yours = tasks.filter((t) => t.mine)
    const others = tasks.filter((t) => !t.mine)
    if (others.length === 0) return [{ key: 'all', title: '', tasks }]
    const groups: TaskGroup[] = []
    if (yours.length > 0) groups.push({ key: 'yours', title: 'Yours', tasks: yours })
    groups.push({ key: 'others', title: 'Rest of the team', tasks: others })
    return groups
  }
  return [{ key: 'all', title: '', tasks }]
}

// ---------------------------------------------------------------------------------------------
// Words for dates.

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function monthDay(date: string, today: string): string {
  const label = `${MONTH_SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${date.slice(0, 4)}`
}

/** "Wed Nov 11". */
export function dayDetail(date: string): string {
  return `${WEEKDAY_SHORT[weekday(date)]} ${MONTH_SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`
}

function relativeDay(date: string, today: string): string | null {
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  return null
}

/** "3:00 PM" for `15:00`. */
export function timeWords(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2))
  const m = hhmm.slice(3, 5)
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${m} ${suffix}`
}

/**
 * A due value in words: "Today", "Tomorrow", "Yesterday", the weekday within 6 days, else
 * "Nov 20" ("Nov 20, 2027" in another year); a timed one adds "3:00 PM".
 */
export function dueWords(due: string, today: string, opts: { short?: boolean } = {}): string {
  const date = dueDate(due)
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000)
  let words: string
  if (days === 0) words = 'Today'
  else if (days === 1) words = 'Tomorrow'
  else if (days === -1) words = 'Yesterday'
  else if (days > 1 && days <= 6)
    words = (opts.short ? WEEKDAY_SHORT : WEEKDAY_LONG)[weekday(date)] ?? ''
  else words = monthDay(date, today)
  return due.length > 10 ? `${words} ${timeWords(due.slice(11, 16))}` : words
}

/** Past its date, or past its time today. */
export function isOverdue(
  task: Pick<TaskView, 'due' | 'dueAt' | 'status'>,
  today: string,
  now: Date,
): boolean {
  if (!task.due || task.status === 'done') return false
  if (dueDate(task.due) < today) return true
  return task.dueAt !== null && Date.parse(task.dueAt) < now.getTime()
}

// ---------------------------------------------------------------------------------------------
// Quick add.

export interface Chip {
  kind: 'date' | 'recur' | 'priority' | 'project' | 'label' | 'assignee'
  label: string
}

/** What a quick-add line will set, as the chips under the input show it. */
export function chipsFor(parsed: ParsedTask, today: string): Chip[] {
  const chips: Chip[] = []
  if (parsed.due) chips.push({ kind: 'date', label: dueWords(parsed.due, today, { short: true }) })
  if (parsed.recur) chips.push({ kind: 'recur', label: parsed.recur })
  if (parsed.priority && parsed.priority < 4)
    chips.push({ kind: 'priority', label: `P${parsed.priority}` })
  if (parsed.project) chips.push({ kind: 'project', label: `#${parsed.project}` })
  for (const label of parsed.labels) chips.push({ kind: 'label', label: `@${label}` })
  if (parsed.assignee) chips.push({ kind: 'assignee', label: `+${parsed.assignee}` })
  return chips
}

/** The member a `+name` names: by handle, by email, or by the email's local part. */
export function resolvePerson<P extends { email: string; handle: string }>(
  people: readonly P[],
  name: string,
): P | null {
  const n = name.toLowerCase()
  return (
    people.find((p) => p.handle.toLowerCase() === n) ??
    people.find((p) => p.email.toLowerCase() === n) ??
    people.find((p) => p.email.toLowerCase().split('@')[0] === n) ??
    null
  )
}

/**
 * A ParsedTask back as a quick-add line, for Ramble's review: the title then the words it
 * recognized ("Call Sam fri 3pm p1"), or, when those don't say the same thing again, the
 * fields spelled out ("Call Sam 2026-11-13 15:00 p1").
 */
export function lineFor(task: ParsedTask, reparse: (text: string) => ParsedTask): string {
  const spoken = [task.title, ...(task.tokens ?? []).map((t) => t.text)].filter(Boolean).join(' ')
  if (task.tokens?.length && sameTask(reparse(spoken), task)) return spoken
  const parts = [task.title]
  if (task.recur) parts.push(task.recur)
  if (task.due) {
    // With a rule, the quick-add parser starts at the rule's first occurrence and drops a date.
    if (!task.recur) parts.push(task.due.slice(0, 10))
    if (task.due.length > 10) parts.push(task.due.slice(11, 16))
  }
  if (task.priority && task.priority < 4) parts.push(`p${task.priority}`)
  if (task.project) parts.push(`#${task.project.replace(/\s+/g, '_')}`)
  for (const l of task.labels ?? []) parts.push(`@${l}`)
  if (task.assignee) parts.push(`+${task.assignee}`)
  return parts.filter(Boolean).join(' ')
}

function sameTask(a: ParsedTask, b: ParsedTask): boolean {
  return (
    a.title === b.title &&
    a.due === b.due &&
    a.recur === b.recur &&
    a.priority === b.priority &&
    a.project === b.project &&
    a.assignee === b.assignee &&
    (a.labels ?? []).join(',') === (b.labels ?? []).join(',')
  )
}

/** Initials for an assignee chip: "alex.kim@…" → "AK". */
export function personInitials(email: string, name?: string): string {
  const source = name?.trim() || email.split('@')[0] || email
  const words = source.split(/[\s._-]+/).filter(Boolean)
  const first = words[0]?.[0] ?? '?'
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

// ---------------------------------------------------------------------------------------------
// Optimistic copies: what a task looks like once a change lands, before the server says so.

export function withPatch(task: TaskView, patch: TaskPatch, tz: string): TaskView {
  const next: TaskView = { ...task }
  if (patch.title !== undefined) next.title = patch.title
  if (patch.notes !== undefined) next.notes = patch.notes
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.recur !== undefined) next.recur = patch.recur
  if (patch.project !== undefined) next.project = patch.project
  if (patch.labels !== undefined) next.labels = patch.labels
  if (patch.assignee !== undefined) next.assignee = patch.assignee
  if (patch.order !== undefined) next.order = patch.order
  if (patch.due !== undefined) {
    next.due = patch.due
    const zone = patch.tz ?? task.tz ?? tz
    next.tz = patch.due && isTimed(patch.due) ? zone : null
    next.dueAt = patch.due ? dueInstant(patch.due, zone) : null
  }
  return next
}

/** A task as completing it leaves it: done, or (recurring) moved to its next date. */
export function completedCopy(task: TaskView, today: string, now: Date): TaskView {
  if (task.recur) {
    const due = nextDue(task.recur, task.due ?? undefined, today)
    if (due) {
      const zone = task.tz ?? 'UTC'
      return { ...task, due, dueAt: isTimed(due) ? dueInstant(due, zone) : null }
    }
  }
  return { ...task, status: 'done', completed: now.toISOString() }
}

/** Which list a task opened by link belongs in. */
export function homeViewOf(task: TaskView, today: string): TaskViewSpec {
  if (task.status === 'done') return { id: 'done' }
  if (task.project) return { id: 'project', space: task.space, project: task.project }
  if (task.mine && task.due) return { id: dueDate(task.due) <= today ? 'today' : 'upcoming' }
  // Someone else's team task is in none of your own lists, only in All tasks.
  if (!task.mine) return { id: 'all' }
  return { id: 'inbox' }
}

export function viewUrl(view: TaskViewSpec): string {
  switch (view.id) {
    case 'inbox':
      return '/tasks'
    case 'project':
      return projectUrl(view.space, view.project)
    default:
      return `/tasks/${view.id}`
  }
}

export function projectUrl(space: string, project: string): string {
  return `/tasks/project/${encodeURIComponent(space)}/${encodeURIComponent(project)}`
}

export function itemUrl(task: { space: string; id: string }): string {
  return `/tasks/item/${encodeURIComponent(task.space)}/${encodeURIComponent(task.id)}`
}
