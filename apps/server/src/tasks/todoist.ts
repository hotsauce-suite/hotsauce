import { createHash } from 'node:crypto'
import { localNow, type NewTask, normalizeRecurrence, parseQuickAdd } from '@hearth/format'
import { z } from 'zod'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { Tasks } from './service.js'

export const TODOIST_API = 'https://api.todoist.com/api/v1/'
export const MAX_IMPORT_TASKS = 5000
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 200
/** A bound on pages per endpoint, so a cursor that never ends can't loop forever. */
const MAX_PAGES = 200
const FROM = 'todoist'

/** A task ready to write, before `createdBy` is known. */
export type ImportedTask = Omit<NewTask, 'createdBy'> & { source: NonNullable<NewTask['source']> }

export interface ImportResult {
  imported: number
  skipped: number
  projects: string[]
}

// ── the API ──────────────────────────────────────────────────────────────────

const Due = z.looseObject({
  date: z.string(),
  datetime: z.string().nullish(),
  timezone: z.string().nullish(),
  string: z.string().nullish(),
  is_recurring: z.boolean().nullish(),
})

const ApiTask = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  content: z.string(),
  description: z.string().nullish(),
  priority: z.number().int().min(1).max(4).nullish(),
  due: Due.nullish(),
  project_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  section_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  parent_id: z.union([z.string(), z.number()]).transform(String).nullish(),
  labels: z.array(z.string()).nullish(),
})
export type TodoistApiTask = z.input<typeof ApiTask>

const ApiProject = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  inbox_project: z.boolean().nullish(),
  is_inbox_project: z.boolean().nullish(),
})

const ApiSection = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
})

/** `results` with a `next_cursor`, or (older endpoints) a bare array. */
const Page = z.union([
  z.object({ results: z.array(z.unknown()), next_cursor: z.string().nullish() }),
  z.array(z.unknown()).transform((results) => ({ results, next_cursor: null })),
])

function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

/**
 * A Todoist due (`date` or `datetime`, maybe with a zone) as a Hearth due and zone. A floating
 * time is wall time in the task's zone (else `defaultTz`); a UTC time is converted to it.
 */
export function mapTodoistDue(
  due: { date: string; datetime?: string | null | undefined; timezone?: string | null | undefined },
  defaultTz: string,
): { due: string; tz?: string } | null {
  const value = due.datetime || due.date
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { due: value }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    value,
  )
  if (!m?.[1] || !m[2]) return null
  const tz = validZone(due.timezone) ?? defaultTz
  if (!m[3]) return { due: `${m[1]}T${m[2]}`, tz }
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return null
  const local = localNow(instant, tz)
  return { due: `${local.date}T${local.time}`, tz }
}

/** Todoist's API priority: 4 is the most urgent (p1), 1 is none. */
function priorityFromApi(p: number | null | undefined): number | undefined {
  return p ? 5 - p : undefined
}

function joinNotes(...parts: Array<string | null | undefined>): string | undefined {
  const text = parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join('\n\n')
  return text || undefined
}

/** Maps what the Todoist API returned to Hearth tasks (ARCHITECTURE §12.2). */
export function mapTodoistApi(
  data: { projects: unknown[]; sections: unknown[]; tasks: unknown[] },
  opts: { tz: string },
): ImportedTask[] {
  const projects = new Map<string, string | null>()
  for (const raw of data.projects) {
    const p = ApiProject.safeParse(raw)
    if (!p.success) continue
    const inbox = p.data.inbox_project || p.data.is_inbox_project || p.data.name === 'Inbox'
    projects.set(p.data.id, inbox ? null : p.data.name)
  }
  const sections = new Map<string, string>()
  for (const raw of data.sections) {
    const s = ApiSection.safeParse(raw)
    if (s.success) sections.set(s.data.id, s.data.name)
  }
  const tasks = data.tasks.flatMap((raw) => {
    const t = ApiTask.safeParse(raw)
    return t.success ? [t.data] : []
  })
  const titles = new Map(tasks.map((t) => [t.id, t.content.trim()]))
  return tasks.map((t) => {
    const labels = [...(t.section_id ? [sections.get(t.section_id)] : []), ...(t.labels ?? [])]
      .filter((l): l is string => Boolean(l?.trim()))
      .map((l) => l.trim())
    const due = t.due ? mapTodoistDue(t.due, opts.tz) : null
    let recur: string | undefined
    let repeats: string | undefined
    if (t.due?.is_recurring && t.due.string) {
      recur = normalizeRecurrence(t.due.string) ?? undefined
      if (!recur) repeats = `Repeats: ${t.due.string}`
    }
    const parent = t.parent_id ? titles.get(t.parent_id) : undefined
    const project = t.project_id ? projects.get(t.project_id) : undefined
    return {
      title: t.content,
      notes: joinNotes(parent ? `Sub-task of: ${parent}` : null, t.description, repeats),
      priority: priorityFromApi(t.priority),
      due: due?.due,
      tz: due?.tz,
      recur,
      project: project ?? undefined,
      labels: [...new Set(labels)],
      source: { kind: 'import' as const, from: FROM, ref: t.id },
    }
  })
}

// ── the CSV export ───────────────────────────────────────────────────────────

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const LABEL_IN_CONTENT = /(^|\s)@([\p{L}\p{N}_\-/]+)/gu

/**
 * A Todoist CSV export (`TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,…,DATE,DATE_LANG,TIMEZONE,…`)
 * as Hearth tasks. `section` rows label the tasks after them; `INDENT` 2+ makes a sub-task of
 * the last task one level up; `@labels` in CONTENT become labels. CSV rows have no id, so the
 * ref is a hash of the project, section, parent and content, numbered when the same row repeats.
 */
export function parseTodoistCsv(
  csv: string,
  opts: { projectName: string; today: string; tz: string },
): ImportedTask[] {
  const [header, ...rows] = parseCsv(csv)
  if (!header) return []
  const col = new Map(header.map((h, i) => [h.trim().toUpperCase(), i]))
  if (!col.has('TYPE') || !col.has('CONTENT')) {
    throw new HearthError(
      'bad_request',
      'That isn’t a Todoist CSV export (no TYPE and CONTENT columns)',
    )
  }
  const get = (r: string[], name: string) => {
    const i = col.get(name)
    return i === undefined ? '' : (r[i] ?? '').trim()
  }
  const project = /^inbox$/i.test(opts.projectName.trim()) ? undefined : opts.projectName.trim()
  const out: ImportedTask[] = []
  const parents: string[] = []
  const seen = new Map<string, number>()
  let section: string | undefined
  for (const r of rows) {
    const type = get(r, 'TYPE').toLowerCase()
    if (type === 'section') {
      section = get(r, 'CONTENT') || undefined
      parents.length = 0
      continue
    }
    if (type !== 'task') continue
    const labels: string[] = section ? [section] : []
    const title = get(r, 'CONTENT')
      .replace(LABEL_IN_CONTENT, (_, lead: string, label: string) => {
        labels.push(label)
        return lead
      })
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) continue
    const indent = Math.max(Number.parseInt(get(r, 'INDENT'), 10) || 1, 1)
    parents.length = Math.min(parents.length, indent - 1)
    const parent = indent > 1 ? parents[indent - 2] : undefined
    parents[indent - 1] = title

    const date = get(r, 'DATE')
    const parsed = date ? parseQuickAdd(date, { today: opts.today }) : null
    const due = parsed?.due
    const unparsed = date && !due && !parsed?.recur ? `Due in Todoist: ${date}` : undefined
    const csvPriority = Number.parseInt(get(r, 'PRIORITY'), 10)
    const key = [project ?? '', section ?? '', parent ?? '', title].join('\n')
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    const hash = createHash('sha1').update(key).digest('hex').slice(0, 16)
    out.push({
      title,
      notes: joinNotes(parent ? `Sub-task of: ${parent}` : null, get(r, 'DESCRIPTION'), unparsed),
      priority: csvPriority >= 1 && csvPriority <= 3 ? csvPriority : undefined,
      due,
      tz: due?.includes('T') ? (validZone(get(r, 'TIMEZONE')) ?? opts.tz) : undefined,
      recur: parsed?.recur,
      project,
      labels: [...new Set(labels)],
      source: { kind: 'import', from: FROM, ref: `csv:${hash}${n > 1 ? `:${n}` : ''}` },
    })
  }
  return out
}

// ── the import ───────────────────────────────────────────────────────────────

export type TodoistImportInput =
  | { token: string; tz?: string | undefined }
  | { csv: string; projectName: string; tz?: string | undefined }

/**
 * One-time import from Todoist into the member's personal space, one commit. Tasks already
 * imported (by their Todoist id, or a CSV row's hash) are skipped, so running it again only adds
 * new ones. The API token is used for these requests only: never logged, stored or returned.
 */
export class TodoistImport {
  readonly #tasks: Pick<Tasks, 'importedRefs' | 'personalSpace' | 'addMany'>
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  readonly #api: string

  constructor(deps: {
    tasks: Pick<Tasks, 'importedRefs' | 'personalSpace' | 'addMany'>
    fetch?: typeof fetch
    now?: () => Date
    /** Tests point this elsewhere. */
    api?: string
  }) {
    this.#tasks = deps.tasks
    this.#fetch = deps.fetch ?? fetch
    this.#now = deps.now ?? (() => new Date())
    this.#api = deps.api ?? TODOIST_API
  }

  async import(principal: Principal, input: TodoistImportInput): Promise<ImportResult> {
    const space = await this.#tasks.personalSpace(principal)
    if (!space) throw new HearthError('forbidden', 'Your personal space isn’t available right now')
    const tz = validZone(input.tz) ?? 'UTC'
    const all =
      'token' in input
        ? mapTodoistApi(await this.#fetchAll(input.token), { tz })
        : parseTodoistCsv(input.csv, {
            projectName: input.projectName,
            today: localNow(this.#now(), tz).date,
            tz,
          })
    const done = await this.#tasks.importedRefs(principal, FROM)
    const fresh = all.filter((t) => !done.has(t.source.ref ?? ''))
    const batch = fresh.slice(0, MAX_IMPORT_TASKS)
    await this.#tasks.addMany(principal, space, batch, `tasks: import ${batch.length} from Todoist`)
    const projects = [...new Set(batch.map((t) => t.project).filter((p): p is string => !!p))]
    return {
      imported: batch.length,
      skipped: all.length - fresh.length,
      projects: projects.sort((a, b) => a.localeCompare(b)),
    }
  }

  async #fetchAll(token: string) {
    const [projects, sections, tasks] = await Promise.all([
      this.#pages('projects', token),
      this.#pages('sections', token),
      this.#pages('tasks', token),
    ])
    return { projects, sections, tasks }
  }

  async #pages(endpoint: string, token: string): Promise<unknown[]> {
    const out: unknown[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(endpoint, this.#api)
      url.searchParams.set('limit', String(PAGE_LIMIT))
      if (cursor) url.searchParams.set('cursor', cursor)
      let res: Response
      try {
        res = await this.#fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch {
        throw new HearthError('host_error', 'Couldn’t reach Todoist; try again in a moment')
      }
      if (res.status === 401 || res.status === 403) {
        throw new HearthError('bad_request', 'Todoist didn’t accept that API token')
      }
      if (!res.ok)
        throw new HearthError('host_error', `Todoist answered ${res.status} for ${endpoint}`)
      const parsed = Page.safeParse(await res.json().catch(() => null))
      if (!parsed.success)
        throw new HearthError('host_error', `Todoist answered oddly for ${endpoint}`)
      out.push(...parsed.data.results)
      cursor = parsed.data.next_cursor ?? null
      if (!cursor || out.length > MAX_IMPORT_TASKS * 4) break
    }
    return out
  }
}
