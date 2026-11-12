// Hearth Tasks (ARCHITECTURE §12): one task per Markdown file, `tasks/<id>.md`, with the task's
// fields in frontmatter and its notes as the body. Everything here is pure: dates are the
// member's wall-clock dates, and the caller says what "today" is in their time zone.

import { z } from 'zod'
import { patchFrontmatter } from './frontmatter.js'
import { isId, newId } from './ids.js'

export const TASKS_FOLDER = 'tasks'

/** `tasks/<id>.md`. */
export function taskPath(id: string): string {
  return `${TASKS_FOLDER}/${id}.md`
}

/** The id of a task file, or null when the path isn't `tasks/<id>.md`. */
export function taskIdOf(path: string): string | null {
  const match = /^tasks\/([0-9A-Z]{26})\.md$/.exec(path)
  return match?.[1] && isId(match[1]) ? match[1] : null
}

/** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` when the task is due at a time of day (wall clock). */
const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/

export const TaskSource = z.looseObject({
  kind: z.enum(['manual', 'meeting', 'voice', 'import', 'mcp']),
  /** For `meeting`: the note and the 1-based line of the `- [ ]` item it came from. */
  space: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  text: z.string().optional(),
  /** For `import`: where from, and its id there. */
  from: z.string().optional(),
  ref: z.string().optional(),
})
export type TaskSource = z.infer<typeof TaskSource>

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

/** Unknown keys pass through untouched. */
export const TaskFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('task'),
  title: z.string(),
  status: z.enum(['open', 'done']),
  /** 1 is the most urgent (Todoist's p1); 4 is no priority. */
  priority: optional(z.number().int().min(1).max(4)),
  due: optional(z.string().regex(DUE)),
  /** The IANA zone a timed `due` is in. */
  tz: optional(z.string()),
  /** A rule `parseRecurrence` accepts, normalized: `every week`, `every monday, friday`. */
  recur: optional(z.string()),
  project: optional(z.string()),
  labels: optional(z.array(z.string())),
  /** The member it's assigned to, by email. */
  assignee: optional(z.string()),
  created: z.string(),
  created_by: z.string(),
  completed: optional(z.string()),
  completed_by: optional(z.string()),
  /** Manual order within a list; lower first. */
  order: optional(z.number()),
  source: optional(TaskSource),
})
export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>

export interface NewTask {
  title: string
  notes?: string | undefined
  priority?: number | undefined
  due?: string | undefined
  tz?: string | undefined
  recur?: string | undefined
  project?: string | undefined
  labels?: string[] | undefined
  assignee?: string | undefined
  order?: number | undefined
  source?: TaskSource | undefined
  createdBy: string
  /** ISO instant; defaults to now. */
  created?: string | undefined
  id?: string | undefined
}

/** A task file's text and path. Empty optional fields are left out. */
export function newTaskFile(task: NewTask): { id: string; path: string; text: string } {
  const id = task.id ?? newId()
  const title = oneLine(task.title) || 'Untitled task'
  const fields: Record<string, unknown> = {
    id,
    type: 'task',
    title,
    status: 'open',
    priority: task.priority && task.priority !== 4 ? task.priority : undefined,
    due: task.due || undefined,
    tz: task.due && isTimed(task.due) ? task.tz : undefined,
    recur: task.recur || undefined,
    project: task.project?.trim() || undefined,
    labels: task.labels && task.labels.length > 0 ? task.labels : undefined,
    assignee: task.assignee?.trim().toLowerCase() || undefined,
    created: task.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    created_by: task.createdBy.toLowerCase(),
    order: task.order,
    source: task.source,
  }
  const notes = task.notes?.trim() ? `${task.notes.trim()}\n` : ''
  return { id, path: taskPath(id), text: patchFrontmatter(`\n${notes}`, fields) }
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function isTimed(due: string): boolean {
  return due.includes('T')
}

/** The date part of a due value. */
export function dueDate(due: string): string {
  return due.slice(0, 10)
}

// ---------------------------------------------------------------------------------------------
// Plain calendar dates. A date is `YYYY-MM-DD`; arithmetic runs on UTC midnights, so no zone or
// daylight-saving change can move it.

const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function toUtc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS)
}

/** Adds months, keeping the day of the month where it exists (Jan 31 + 1 month = Feb 28). */
export function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7)) - 1 + months
  const d = Number(date.slice(8, 10))
  const year = y + Math.floor(m / 12)
  const month = ((m % 12) + 12) % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return fromUtc(Date.UTC(year, month, Math.min(d, last)))
}

/** 0 is Sunday. */
export function weekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay()
}

export function isValidDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** The member's date and time now, in `timeZone`. */
export function localNow(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

/**
 * The instant a timed due value names in `timeZone`, as an ISO string; null for a date-only
 * value. A wall time skipped by a daylight-saving change resolves to the hour after.
 */
export function dueInstant(due: string, timeZone: string): string | null {
  const m = DUE.exec(due)
  if (!m || m[4] === undefined) return null
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  // Two passes of "how far is the zone from UTC at this guess" settle every real offset.
  let guess = wall
  for (let i = 0; i < 2; i++) guess = wall - offsetMs(new Date(guess), timeZone)
  return new Date(guess).toISOString()
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

// ---------------------------------------------------------------------------------------------
// Recurrence. Rules are normalized text so a person reading the file understands them:
//   every day | every weekday | every week | every month | every year
//   every N days | every N weeks | every N months | every N years
//   every monday[, wednesday, ...]

export type Recurrence =
  | { unit: 'day' | 'week' | 'month' | 'year'; every: number }
  | { unit: 'weekday' }
  | { unit: 'weekdays'; days: number[] }

const UNIT_WORDS: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
}

const SHORTCUTS: Record<string, string> = {
  daily: 'every day',
  weekly: 'every week',
  monthly: 'every month',
  yearly: 'every year',
  annually: 'every year',
  'every other day': 'every 2 days',
  'every other week': 'every 2 weeks',
  'every other month': 'every 2 months',
  'every workday': 'every weekday',
}

/** Parses a rule (case and spacing don't matter); null when it isn't one Hearth understands. */
export function parseRecurrence(rule: string): Recurrence | null {
  let text = rule.toLowerCase().replace(/\s+/g, ' ').trim()
  text = SHORTCUTS[text] ?? text
  if (text === 'every weekday') return { unit: 'weekday' }
  let m = /^every (?:(\d{1,3}) )?(days?|weeks?|months?|years?)$/.exec(text)
  if (m?.[2]) {
    const every = m[1] ? Number(m[1]) : 1
    if (every < 1) return null
    return { unit: UNIT_WORDS[m[2]] as 'day', every }
  }
  m = /^every (.+)$/.exec(text)
  if (m?.[1]) {
    const days = m[1].split(/\s*(?:,|\band\b)\s*/).filter(Boolean)
    const idx = days.map(weekdayIndex)
    if (idx.length > 0 && idx.every((i) => i !== null)) {
      return { unit: 'weekdays', days: [...new Set(idx as number[])].sort((a, b) => a - b) }
    }
  }
  return null
}

/** The normalized text of a rule. */
export function formatRecurrence(r: Recurrence): string {
  if (r.unit === 'weekday') return 'every weekday'
  if (r.unit === 'weekdays') {
    // Monday first, the way people say a week.
    const order = [...r.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    return `every ${order.map((d) => WEEKDAYS[d]).join(', ')}`
  }
  return r.every === 1 ? `every ${r.unit}` : `every ${r.every} ${r.unit}s`
}

/** `every week` etc. normalized, or null. */
export function normalizeRecurrence(rule: string): string | null {
  const r = parseRecurrence(rule)
  return r ? formatRecurrence(r) : null
}

function weekdayIndex(word: string): number | null {
  const w = word.trim().toLowerCase()
  if (w.length < 2) return null
  const i = WEEKDAYS.findIndex(
    (name) =>
      name.startsWith(w) && (w.length >= 3 || w === 'tu' || w === 'th' || w === 'sa' || w === 'su'),
  )
  return i === -1 ? null : i
}

/** The occurrence after `date` (exclusive). */
function nextAfter(r: Recurrence, date: string): string {
  switch (r.unit) {
    case 'day':
      return addDays(date, r.every)
    case 'week':
      return addDays(date, 7 * r.every)
    case 'month':
      return addMonths(date, r.every)
    case 'year':
      return addMonths(date, 12 * r.every)
    case 'weekday': {
      let d = addDays(date, 1)
      while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1)
      return d
    }
    case 'weekdays': {
      let d = addDays(date, 1)
      while (!r.days.includes(weekday(d))) d = addDays(d, 1)
      return d
    }
  }
}

/** The first occurrence on or after `date`. */
export function firstOccurrence(rule: string, date: string): string {
  const r = parseRecurrence(rule)
  if (!r) return date
  if (r.unit === 'weekday' && (weekday(date) === 0 || weekday(date) === 6))
    return nextAfter(r, date)
  if (r.unit === 'weekdays' && !r.days.includes(weekday(date))) return nextAfter(r, date)
  return date
}

/**
 * The due value a recurring task moves to when it's completed: the next occurrence after its
 * current due date, caught up to today if it was overdue. The time of day is kept. Null when the
 * rule isn't understood.
 */
export function nextDue(rule: string, due: string | undefined, today: string): string | null {
  const r = parseRecurrence(rule)
  if (!r) return null
  const time = due && isTimed(due) ? due.slice(10) : ''
  let d = nextAfter(r, due ? dueDate(due) : today)
  // A safety bound: a rule always advances, but never loop forever on bad input.
  for (let i = 0; d < today && i < 5000; i++) d = nextAfter(r, d)
  return d + time
}

// ---------------------------------------------------------------------------------------------
// Quick add: "Call Sam fri 3pm p1 #Ops @calls +alex every week". The tokens are taken out of the
// text; what's left is the title.

export type QuickToken = 'date' | 'time' | 'recur' | 'priority' | 'project' | 'label' | 'assignee'

export interface ParsedTask {
  title: string
  due?: string
  recur?: string
  priority?: number
  project?: string
  labels: string[]
  /** What followed `+`: a handle or an email, for the caller to resolve to a member. */
  assignee?: string
  /** The recognized pieces, for highlighting them as the member types. */
  tokens: Array<{ kind: QuickToken; text: string; from: number; to: number }>
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

interface Match {
  kind: QuickToken
  from: number
  to: number
  apply: (out: Draft) => void
}

interface Draft {
  date?: string
  time?: string
  recur?: string
  priority?: number
  project?: string
  labels: string[]
  assignee?: string
}

const WORD_START = '(?<![\\p{L}\\p{N}_#@+\\-/])'
const WORD_END = '(?![\\p{L}\\p{N}_\\-])'

function re(body: string): RegExp {
  return new RegExp(`${WORD_START}(?:${body})${WORD_END}`, 'giu')
}

const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const DAY_RE = '(\\d{1,2})(?:st|nd|rd|th)?'
const WEEKDAY_RE =
  '(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)'
const TIME_RE =
  '(?:at |@ ?)?(?:(\\d{1,2})(?::(\\d{2}))? ?(am|pm|a\\.m\\.|p\\.m\\.)|(\\d{1,2}):(\\d{2})|noon|midnight)'

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace('.', '')
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)))
}

/** The year that makes month/day the next one on or after today. */
function nextYearFor(today: string, month: number, day: number): number {
  const y = Number(today.slice(0, 4))
  const candidate = `${y}-${pad(month)}-${pad(day)}`
  return candidate < today ? y + 1 : y
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function parseTime(m: RegExpExecArray): string | null {
  const raw = m[0].toLowerCase()
  if (raw.endsWith('noon')) return '12:00'
  if (raw.endsWith('midnight')) return '00:00'
  if (m[1] !== undefined) {
    let h = Number(m[1])
    const min = Number(m[2] ?? 0)
    const pm = (m[3] ?? '').startsWith('p')
    if (h < 1 || h > 12 || min > 59) return null
    if (pm && h !== 12) h += 12
    if (!pm && h === 12) h = 0
    return `${pad(h)}:${pad(min)}`
  }
  if (m[4] !== undefined) {
    const h = Number(m[4])
    const min = Number(m[5])
    if (h > 23 || min > 59) return null
    return `${pad(h)}:${pad(min)}`
  }
  return null
}

/**
 * Parses quick-add text. `today` is the member's date (`YYYY-MM-DD`). Only the first date, time,
 * rule and priority count; a second one stays in the title. `#project` takes one word (letters,
 * digits, `-`, `_`, `/`); `@label` the same; `+name` an assignee handle or email.
 */
export function parseQuickAdd(text: string, opts: { today: string }): ParsedTask {
  const today = opts.today
  const matches: Match[] = []
  const taken = (from: number, to: number) => matches.some((m) => from < m.to && to > m.from)
  const add = (kind: QuickToken, from: number, to: number, apply: (out: Draft) => void) => {
    if (taken(from, to)) return false
    if (matches.some((m) => m.kind === kind || (kind === 'date' && m.kind === 'recur'))) {
      if (kind !== 'label') return false
    }
    matches.push({ kind, from, to, apply })
    return true
  }
  const scan = (pattern: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of text.matchAll(pattern)) fn(m as RegExpExecArray)
  }

  const recurrence = (m: RegExpExecArray) => {
    const rule = normalizeRecurrence(m[0])
    if (!rule) return
    add('recur', m.index, m.index + m[0].length, (d) => {
      d.recur = rule
    })
  }
  // Recurrence first: "every monday" must not be read as a date "monday"; and an "every …" rule
  // wins over a word like "weekly" in the title.
  scan(
    re(
      `every(?: other)? (?:\\d{1,3} )?(?:days?|weeks?|months?|years?|weekday|workday)|every ${WEEKDAY_RE}(?:(?:,? and |, ?| )${WEEKDAY_RE})*`,
    ),
    recurrence,
  )
  scan(re('daily|weekly|monthly|yearly|annually'), recurrence)

  // Dates.
  const date = (m: RegExpExecArray, value: string | null) => {
    if (!value) return
    add('date', m.index, m.index + m[0].length, (d) => {
      d.date = value
    })
  }
  scan(re('(\\d{4})-(\\d{2})-(\\d{2})'), (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    date(m, isValidDate(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null)
  })
  scan(re('(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?'), (m) => {
    // US order, as Acme writes dates.
    const mo = Number(m[1])
    const d = Number(m[2])
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : nextYearFor(today, mo, d)
    if (!m[3] && !isValidDate(y, mo, d)) y = Number(today.slice(0, 4))
    date(m, isValidDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null)
  })
  scan(re(`${MONTH_RE} ${DAY_RE}(?:,? (\\d{4}))?|${DAY_RE} ${MONTH_RE}(?:,? (\\d{4}))?`), (m) => {
    const month = monthIndex(m[1] ?? m[5] ?? '') + 1
    const day = Number(m[2] ?? m[4])
    const yearText = m[3] ?? m[6]
    const y = yearText ? Number(yearText) : nextYearFor(today, month, day)
    date(m, month > 0 && isValidDate(y, month, day) ? `${y}-${pad(month)}-${pad(day)}` : null)
  })
  scan(re('today|tonight'), (m) => {
    date(m, today)
    if (m[0].toLowerCase() === 'tonight') {
      add('time', m.index, m.index, (d) => {
        d.time ??= '19:00'
      })
    }
  })
  scan(re('day after tomorrow'), (m) => date(m, addDays(today, 2)))
  scan(re('tomorrow|tmrw|tmr'), (m) => date(m, addDays(today, 1)))
  scan(re('yesterday'), (m) => date(m, addDays(today, -1)))
  scan(re('in (\\d{1,3}) (days?|weeks?|months?)'), (m) => {
    const n = Number(m[1])
    const unit = (m[2] ?? '').replace(/s$/, '')
    date(m, unit === 'month' ? addMonths(today, n) : addDays(today, unit === 'week' ? 7 * n : n))
  })
  scan(re('next week'), (m) => date(m, nextWeekday(today, 1, true)))
  scan(re('next month'), (m) => date(m, `${addMonths(today, 1).slice(0, 8)}01`))
  scan(re('(?:this )?weekend'), (m) => date(m, nextWeekday(today, 6, false)))
  scan(re(`(next |this )?${WEEKDAY_RE}`), (m) => {
    const target = weekdayIndex(m[2] ?? '')
    if (target === null) return
    const next = (m[1] ?? '').toLowerCase().startsWith('next')
    // "fri" is the coming Friday (today if it's Friday); "next fri" is a week after that.
    let d = nextWeekday(today, target, false)
    if (next) d = addDays(d, 7)
    date(m, d)
  })

  // Time of day.
  scan(re(TIME_RE), (m) => {
    const t = parseTime(m)
    if (!t) return
    // A bare "at 3" isn't matched (no am/pm or minutes): too likely to be part of the title.
    add('time', m.index, m.index + m[0].length, (d) => {
      d.time = t
    })
  })

  // Priority: p1..p4 (Todoist), or !1..!4.
  scan(/(?<![\p{L}\p{N}_])(?:p|!)([1-4])(?![\p{L}\p{N}_])/giu, (m) => {
    add('priority', m.index, m.index + m[0].length, (d) => {
      d.priority = Number(m[1])
    })
  })

  // #project, @label, +assignee.
  scan(/(?<=^|\s)#([\p{L}\p{N}_\-/]+)/gu, (m) => {
    add('project', m.index, m.index + m[0].length, (d) => {
      d.project = (m[1] ?? '').replace(/_/g, ' ')
    })
  })
  scan(/(?<=^|\s)@([\p{L}\p{N}_\-/]+)/gu, (m) => {
    add('label', m.index, m.index + m[0].length, (d) => {
      const label = (m[1] ?? '').toLowerCase()
      if (!d.labels.includes(label)) d.labels.push(label)
    })
  })
  scan(/(?<=^|\s)\+([\p{L}\p{N}._-]+(?:@[\p{L}\p{N}.-]+)?)/gu, (m) => {
    add('assignee', m.index, m.index + m[0].length, (d) => {
      d.assignee = (m[1] ?? '').toLowerCase().replace(/\.$/, '')
    })
  })

  const draft: Draft = { labels: [] }
  for (const m of matches) m.apply(draft)

  // A time with no date is today; a rule with no date starts at its first occurrence.
  let due: string | undefined
  if (draft.recur) {
    const start = draft.date ?? firstOccurrence(draft.recur, today)
    due = start
  } else if (draft.date) {
    due = draft.date
  } else if (draft.time) {
    due = today
  }
  if (due && draft.time) due = `${due}T${draft.time}`

  const spans = matches.filter((m) => m.to > m.from).sort((a, b) => a.from - b.from)
  let title = ''
  let at = 0
  for (const s of spans) {
    title += `${text.slice(at, s.from)} `
    at = s.to
  }
  title = oneLine(`${title}${text.slice(at)}`)
    // "Call Sam on" / "by" / "at" left dangling where a date was taken out.
    .replace(/\s+(?:on|by|at|due|every)$/i, '')
    .trim()

  const result: ParsedTask = {
    title,
    labels: draft.labels,
    tokens: spans.map((s) => ({
      kind: s.kind,
      text: text.slice(s.from, s.to),
      from: s.from,
      to: s.to,
    })),
  }
  if (due) result.due = due
  if (draft.recur) result.recur = draft.recur
  if (draft.priority) result.priority = draft.priority
  if (draft.project) result.project = draft.project
  if (draft.assignee) result.assignee = draft.assignee
  return result
}

/** The next `target` weekday on or after today (`strict`: after today). */
function nextWeekday(today: string, target: number, strict: boolean): string {
  let d = strict ? addDays(today, 1) : today
  while (weekday(d) !== target) d = addDays(d, 1)
  return d
}
