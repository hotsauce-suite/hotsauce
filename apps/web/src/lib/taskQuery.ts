// The `tasks` code block in a doc (docs/plans/2026-11-12-docs-task-lists.md): its plain-text
// query, read into the `GET /api/tasks` filter plus what the server can't filter on.

import { addDays, localNow } from '@hearth/format'
import type { TaskFilter, TaskView } from '../api/tasks'

export const TASKS_INFO = 'tasks'
export const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export interface TaskQuery {
  filter: TaskFilter
  /** Filtered here: the server has no label filter. */
  label: string | null
  limit: number
  /** One line per key or value that wasn't understood; the rest of the query still runs. */
  problems: string[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Reads a block's text. `timeZone` decides what "today" means. */
export function parseTaskQuery(text: string, timeZone: string, now = new Date()): TaskQuery {
  const query: TaskQuery = {
    filter: { status: 'open' },
    label: null,
    limit: DEFAULT_LIMIT,
    problems: [],
  }
  const today = localNow(now, timeZone).date
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 0) {
      query.problems.push(`“${line}” needs a key, like “project: ${line}”.`)
      continue
    }
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const lower = value.toLowerCase()
    const bad = (hint: string) => query.problems.push(`${key}: “${value}” isn’t ${hint}.`)
    switch (key) {
      case 'status':
        if (lower === 'open' || lower === 'done' || lower === 'all') query.filter.status = lower
        else bad('open, done or all')
        break
      case 'mine':
        if (['yes', 'true', 'me'].includes(lower)) query.filter.mine = true
        else if (['no', 'false', 'anyone'].includes(lower)) query.filter.mine = false
        else bad('yes or no')
        break
      case 'project':
        query.filter.project = lower === 'none' || lower === 'inbox' ? '' : value
        break
      case 'space':
        if (value) query.filter.space = value
        break
      case 'due': {
        const range = dueRange(lower, today)
        if (range) Object.assign(query.filter, range)
        else bad('today, overdue, this week, next 7 days, before YYYY-MM-DD or after YYYY-MM-DD')
        break
      }
      case 'label':
        query.label = value.replace(/^@/, '') || null
        break
      case 'search':
        if (value) query.filter.q = value
        break
      case 'limit': {
        const n = Number(value)
        if (Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT) query.limit = n
        else bad(`a number from 1 to ${MAX_LIMIT}`)
        break
      }
      default:
        query.problems.push(
          `“${key}” isn’t a task query key. Use status, mine, project, space, due, label, search or limit.`,
        )
    }
  }
  // The label filter runs here, so the server returns more than the limit to filter from.
  query.filter.limit = query.label ? 500 : query.limit
  return query
}

function dueRange(value: string, today: string): Pick<TaskFilter, 'dueBefore' | 'dueAfter'> | null {
  if (value === 'today') return { dueBefore: today }
  if (value === 'overdue') return { dueBefore: addDays(today, -1) }
  if (value === 'this week' || value === 'next 7 days') return { dueBefore: addDays(today, 6) }
  const [word, date = ''] = value.split(/\s+/)
  if (!DATE.test(date)) return null
  if (word === 'before') return { dueBefore: addDays(date, -1) }
  if (word === 'after') return { dueAfter: addDays(date, 1) }
  return null
}

/** The tasks the block shows, from what the server returned. */
export function applyTaskQuery(query: TaskQuery, tasks: TaskView[]): TaskView[] {
  const label = query.label?.toLowerCase()
  const kept = label ? tasks.filter((t) => t.labels.some((l) => l.toLowerCase() === label)) : tasks
  return kept.slice(0, query.limit)
}
