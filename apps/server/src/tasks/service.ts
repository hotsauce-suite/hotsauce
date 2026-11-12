import {
  addDays,
  dueInstant,
  FrontmatterError,
  firstOccurrence,
  isTimed,
  localNow,
  type NewTask,
  newTaskFile,
  nextDue,
  normalizeRecurrence,
  parseFrontmatter,
  parseQuickAdd,
  patchFrontmatter,
  SPACE_LAYOUT,
  TaskFrontmatter,
  type TaskSource,
  taskIdOf,
  taskPath,
} from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { nameFromEmail } from '../auth/principal.js'
import { HearthError } from '../errors.js'
import { type CommitResult, formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import {
  completeActionItem,
  listActionItems,
  type MeetingActionItems,
  openActionItems,
  reopenActionItem,
} from '../meetings/action-items.js'
import { assertTimeZone } from '../meetings/zoned-time.js'
import { type Space, type SpaceService, TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export const MAX_TASK_LIST = 500
const WRITE_ATTEMPTS = 3
const DUE = /^\d{4}-\d{2}-\d{2}(?:T([01]\d|2[0-3]):[0-5]\d)?$/
const TASK_ID = /^[0-9A-Z]{26}$/

export interface TaskView {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  notes: string
  status: 'open' | 'done'
  priority: 1 | 2 | 3 | 4
  due: string | null
  tz: string | null
  /** The instant of a timed due, else null. */
  dueAt: string | null
  recur: string | null
  project: string | null
  labels: string[]
  assignee: string | null
  createdBy: string
  created: string
  completed: string | null
  completedBy: string | null
  order: number | null
  source: TaskSource | null
  /** Mine, for the member asking (ARCHITECTURE §12.1). */
  mine: boolean
}

export interface TaskFilter {
  status?: 'open' | 'done' | 'all' | undefined
  mine?: boolean | undefined
  /** Only this project; `''` is only tasks with no project. */
  project?: string | undefined
  space?: string | undefined
  /** `YYYY-MM-DD`, inclusive: only tasks due on or before it. */
  dueBefore?: string | undefined
  /** `YYYY-MM-DD`, inclusive: only tasks due on or after it. */
  dueAfter?: string | undefined
  /** ISO instants, `(dueAtAfter, dueAtUntil]`: only timed tasks due in that window (reminders). */
  dueAtAfter?: string | undefined
  dueAtUntil?: string | undefined
  /** ISO instant: done tasks completed before it are left out. */
  doneSince?: string | undefined
  q?: string | undefined
  limit?: number | undefined
}

export interface TaskInput {
  title: string
  notes?: string | undefined
  priority?: number | undefined
  due?: string | null | undefined
  tz?: string | undefined
  recur?: string | null | undefined
  project?: string | null | undefined
  labels?: string[] | undefined
  assignee?: string | null | undefined
  order?: number | null | undefined
  source?: TaskSource | undefined
}

/** Some fields of a task; absent (or undefined) leaves a field alone, null clears it. */
export type TaskPatch = { [K in keyof TaskInput]?: TaskInput[K] | undefined }

export interface Person {
  email: string
  name: string
  handle: string
}

/** A task as read from the index or from Git. */
interface TaskRecord {
  space: string
  path: string
  id: string
  blobOid: string
  fm: TaskFrontmatter
}

type TasksGit = Pick<GitStore, 'readFile' | 'commit' | 'readBlobText'>
type TasksIndex = Pick<Index, 'listFiles' | 'search' | 'listSpaces' | 'bodies' | 'bodyAt'>

export interface TasksDeps {
  git: TasksGit
  index: TasksIndex
  spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  now?: () => Date
  log?: (message: string) => void
}

/** The member's own tasks: their personal space, and team tasks assigned to them or theirs unassigned. */
export function isMine(
  task: { space: string; assignee: string | null; createdBy: string },
  principal: Pick<Principal, 'email'>,
  personalSpaces: ReadonlySet<string>,
): boolean {
  if (personalSpaces.has(task.space)) return true
  if (task.space !== TEAM_SPACE) return false
  const me = principal.email.toLowerCase()
  return task.assignee === null ? task.createdBy === me : task.assignee === me
}

/**
 * Open tasks by due date (none last), then time of day (a date-only task before timed ones that
 * day), priority, manual order (none last), created; done tasks newest completed first.
 */
export function compareTasks(a: TaskView, b: TaskView): number {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1
  if (a.status === 'done') return (b.completed ?? '').localeCompare(a.completed ?? '')
  return (
    compareNullsLast(a.due?.slice(0, 10) ?? null, b.due?.slice(0, 10) ?? null) ||
    (a.due ?? '').localeCompare(b.due ?? '') ||
    a.priority - b.priority ||
    compareNullsLast(a.order, b.order) ||
    a.created.localeCompare(b.created) ||
    a.id.localeCompare(b.id)
  )
}

function compareNullsLast<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/**
 * A `+handle` or assignee to a member's email: an email matches exactly; anything else matches a
 * member's handle or the local part of their email. Unknown is bad_request.
 */
export function resolveAssignee(value: string, people: readonly Person[]): string {
  const v = value.trim().toLowerCase()
  // A handle wins; the bare local part only when one person has it (an invited jo@partner.org
  // and a member jo@ourdomain.com both have "jo", so "+jo" must not pick one by name order).
  const byLocal = people.filter((p) => p.email.split('@')[0] === v)
  const person = v.includes('@')
    ? people.find((p) => p.email === v)
    : (people.find((p) => p.handle === v) ?? (byLocal.length === 1 ? byLocal[0] : undefined))
  if (!person) throw new HearthError('bad_request', `No member called "${value.trim()}"`)
  return person.email
}

/** The notes of a task: its body, without the blank line after the frontmatter or trailing space. */
export function notesOf(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

function bodyFor(notes: string): string {
  const trimmed = notes.replace(/\s+$/, '').replace(/^(?:[ \t]*\r?\n)+/, '')
  return trimmed ? `\n${trimmed}\n` : '\n'
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function assertDue(due: string): void {
  // addDays(d, 0) round-trips only a real calendar date (2026-02-30 comes back as March 2).
  if (!DUE.test(due) || addDays(due.slice(0, 10), 0) !== due.slice(0, 10)) {
    throw new HearthError(
      'bad_request',
      `Invalid due date: ${due} (use YYYY-MM-DD or YYYY-MM-DDTHH:mm)`,
    )
  }
}

function safeInstant(due: string, tz: string | null): string | null {
  try {
    return dueInstant(due, tz ?? 'UTC')
  } catch {
    return null
  }
}

function toView(
  rec: TaskRecord,
  notes: string,
  principal: Pick<Principal, 'email'>,
  personal: ReadonlySet<string>,
): TaskView {
  const fm = rec.fm
  const due = fm.due ?? null
  const tz = due && isTimed(due) ? (fm.tz ?? null) : null
  const view: Omit<TaskView, 'mine'> = {
    space: rec.space,
    path: rec.path,
    id: rec.id,
    blobOid: rec.blobOid,
    title: fm.title,
    notes,
    status: fm.status,
    priority: (fm.priority ?? 4) as TaskView['priority'],
    due,
    tz,
    dueAt: due && isTimed(due) ? safeInstant(due, tz) : null,
    recur: fm.recur ?? null,
    project: fm.project ?? null,
    labels: fm.labels ?? [],
    assignee: fm.assignee?.toLowerCase() ?? null,
    createdBy: fm.created_by.toLowerCase(),
    created: fm.created,
    completed: fm.completed ?? null,
    completedBy: fm.completed_by ?? null,
    order: fm.order ?? null,
    source: fm.source ?? null,
  }
  return { ...view, mine: isMine(view, principal, personal) }
}

/** Parses a task file's frontmatter; null when it isn't a Hearth task. */
function parseTask(data: unknown): TaskFrontmatter | null {
  const parsed = TaskFrontmatter.safeParse(data)
  return parsed.success ? parsed.data : null
}

/**
 * Hearth Tasks on the server (ARCHITECTURE §12.2): one Markdown file per task, listed from the
 * index, every write a read → patch → commit retried on a concurrent change.
 */
export class Tasks {
  readonly #git: TasksGit
  readonly #index: TasksIndex
  readonly #spaces: TasksDeps['spaces']
  readonly #syncer: TasksDeps['syncer']
  readonly #now: () => Date
  readonly #log: (message: string) => void

  constructor(deps: TasksDeps) {
    this.#git = deps.git
    this.#index = deps.index
    this.#spaces = deps.spaces
    this.#syncer = deps.syncer
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.warn
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * Tasks in the member's visible spaces (or `opts.spaces`), from the index. Notes come from the
   * index too, for the returned tasks only.
   */
  async list(
    principal: Principal,
    filter: TaskFilter = {},
    opts: { spaces?: Space[] } = {},
  ): Promise<TaskView[]> {
    const visible = opts.spaces ?? (await this.#spaces.visibleSpaces(principal))
    if (filter.space) this.#assertAccess(principal, filter.space)
    const scope = filter.space ? visible.filter((s) => s.name === filter.space) : visible
    const personal = personalOf(visible)
    const status = filter.status ?? 'open'
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? MAX_TASK_LIST), 1), MAX_TASK_LIST)
    const matching = filter.q?.trim() ? this.#searchPaths(filter.q, scope) : null

    const views = this.#records(scope)
      .filter((r) => matching === null || matching.has(`${r.space}\n${r.path}`))
      .map((r) => toView(r, '', principal, personal))
      .filter((t) => {
        if (status !== 'all' && t.status !== status) return false
        if (filter.mine && !t.mine) return false
        // An empty project is "no project" (the Inbox).
        if (filter.project !== undefined && t.project !== (filter.project || null)) return false
        if (filter.dueBefore && (t.due === null || t.due.slice(0, 10) > filter.dueBefore)) {
          return false
        }
        if (filter.dueAfter && (t.due === null || t.due.slice(0, 10) < filter.dueAfter)) {
          return false
        }
        if (filter.dueAtAfter || filter.dueAtUntil) {
          const at = t.dueAt === null ? Number.NaN : Date.parse(t.dueAt)
          if (Number.isNaN(at)) return false
          if (filter.dueAtAfter && at <= Date.parse(filter.dueAtAfter)) return false
          if (filter.dueAtUntil && at > Date.parse(filter.dueAtUntil)) return false
        }
        if (filter.doneSince && t.status === 'done' && (t.completed ?? '') < filter.doneSince) {
          return false
        }
        return true
      })
      .sort(compareTasks)
      .slice(0, limit)

    const bySpace = new Map<string, string[]>()
    for (const t of views) bySpace.set(t.space, [...(bySpace.get(t.space) ?? []), t.path])
    const bodies = new Map<string, string>()
    for (const [space, paths] of bySpace) {
      for (const [path, body] of this.#index.bodies(space, paths)) {
        bodies.set(`${space}\n${path}`, body)
      }
    }
    return views.map((t) => ({ ...t, notes: notesOf(bodies.get(`${t.space}\n${t.path}`) ?? '') }))
  }

  async get(principal: Principal, space: string, id: string): Promise<TaskView> {
    this.#assertAccess(principal, space)
    const file = await this.#read(space, id)
    return toView(file.record, file.notes, principal, await this.#personal(principal))
  }

  /** Projects with any task in the member's visible spaces, and how many of their tasks are open. */
  async projects(
    principal: Principal,
  ): Promise<Array<{ space: string; name: string; open: number }>> {
    const visible = await this.#spaces.visibleSpaces(principal)
    const counts = new Map<string, { space: string; name: string; open: number }>()
    for (const r of this.#records(visible)) {
      const name = r.fm.project
      if (!name) continue
      const key = `${r.space}\n${name}`
      const entry = counts.get(key) ?? { space: r.space, name, open: 0 }
      if (r.fm.status === 'open') entry.open++
      counts.set(key, entry)
    }
    return [...counts.values()].sort(
      (a, b) =>
        Number(b.space === TEAM_SPACE) - Number(a.space === TEAM_SPACE) ||
        a.name.localeCompare(b.name),
    )
  }

  /** Members: owners of personal spaces in the registry, plus the caller. */
  people(principal: Principal): Person[] {
    const byEmail = new Map<string, Person>()
    for (const s of this.#index.listSpaces()) {
      if (s.kind !== 'personal' || !s.ownerEmail) continue
      const email = s.ownerEmail.toLowerCase()
      // A personal space is named by its owner's handle (an invited person's carries their domain).
      byEmail.set(email, { email, name: nameFromEmail(email), handle: s.name })
    }
    const me = principal.email.toLowerCase()
    byEmail.set(me, { email: me, name: principal.name, handle: principal.handle })
    return [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** `GET /api/tasks/from-meetings`: open meeting action items that no visible task came from. */
  async fromMeetings(
    principal: Principal,
    only?: { space: string; path: string },
    opts: { fromIndex?: boolean } = {},
  ): Promise<MeetingActionItems[]> {
    const visible = await this.#spaces.visibleSpaces(principal)
    const taken = new Set(
      this.#records(visible)
        .map((r) => r.fm.source)
        .filter((s) => s?.kind === 'meeting' && s.space && s.path && s.text)
        .map((s) => `${s?.space}\n${s?.path}\n${s?.text?.trim()}`),
    )
    // One note, wherever it is (a team note without the member as attendee, an old one): its
    // open items, read from Git.
    const meetings = only
      ? await this.#oneMeeting(visible, only)
      : await listActionItems(
          {
            index: this.#index,
            // Today reads the index's copy of each note's body (no Git reads, ARCHITECTURE §16).
            git: opts.fromIndex ? indexReader(this.#index) : this.#git,
          },
          principal,
          visible,
        )
    return meetings
      .map((m) => ({
        ...m,
        items: m.items.filter((i) => !taken.has(`${m.space}\n${m.path}\n${i.text.trim()}`)),
      }))
      .filter((m) => m.items.length > 0)
  }

  async #oneMeeting(
    visible: Space[],
    { space, path }: { space: string; path: string },
  ): Promise<MeetingActionItems[]> {
    if (!visible.some((s) => s.name === space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
    const { content } = await this.#git.readFile(space, path)
    const { data } = parseFrontmatter(content)
    if (data.type !== 'meeting')
      throw new HearthError('bad_request', `${path} is not a meeting note`)
    return [
      {
        space,
        path,
        title: typeof data.title === 'string' ? data.title : path,
        date: typeof data.date === 'string' ? data.date : '',
        items: openActionItems(content),
      },
    ]
  }

  /**
   * Every `source.ref` the member already imported from `from`: tasks in their personal space,
   * or that they created (moved to the team). A teammate's import of the same rows doesn't count.
   */
  async importedRefs(principal: Principal, from: string): Promise<Set<string>> {
    const visible = await this.#spaces.visibleSpaces(principal)
    const personal = personalOf(visible)
    const me = principal.email.toLowerCase()
    const refs = new Set<string>()
    for (const r of this.#records(visible)) {
      const s = r.fm.source
      if (!personal.has(r.space) && r.fm.created_by.toLowerCase() !== me) continue
      if (s?.kind === 'import' && s.from === from && s.ref) refs.add(s.ref)
    }
    return refs
  }

  /** The member's personal space, when it is provisioned. */
  async personalSpace(principal: Principal): Promise<string | null> {
    const own = (await this.#spaces.visibleSpaces(principal)).find((s) => s.kind === 'personal')
    return own?.name ?? null
  }

  /** Spaces whose tasks count for a member outside a request (reminders): team and their own. */
  accessibleSpaces(principal: Principal): Space[] {
    return this.#index
      .listSpaces()
      .filter((s) => this.#spaces.canAccess(principal, s.name))
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        label: s.kind === 'team' ? 'Team' : 'Personal',
      }))
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async create(
    principal: Principal,
    input: TaskInput & { space?: string | undefined },
    via?: string,
  ): Promise<TaskView> {
    const me = principal.email.toLowerCase()
    const assignee = input.assignee
      ? resolveAssignee(input.assignee, this.people(principal))
      : undefined
    const personal = await this.personalSpace(principal)
    const space =
      input.space ?? (assignee && assignee !== me ? TEAM_SPACE : (personal ?? TEAM_SPACE))
    this.#assertAccess(principal, space)
    this.#assertAssignable(space, assignee, me)
    const today = localNow(this.#now(), input.tz ?? 'UTC').date
    const fields = this.#fields(principal, input, null, today)
    const file = newTaskFile({
      ...(fields as Omit<NewTask, 'createdBy' | 'title'>),
      title: input.title,
      notes: input.notes,
      createdBy: me,
      created: isoNow(this.#now()),
    })
    const title = parseTask(parseFrontmatter(file.text).data)?.title ?? input.title
    const result = await this.#commit(principal, space, {
      changes: [{ path: file.path, content: file.text }],
      verb: 'create',
      title,
      via,
    })
    return this.#viewOf(principal, space, file.path, file.text, result)
  }

  async quickAdd(
    principal: Principal,
    input: {
      text: string
      tz: string
      space?: string | undefined
      project?: string | undefined
      source?: TaskSource | undefined
      notes?: string | undefined
    },
    via?: string,
  ): Promise<TaskView> {
    assertTimeZone(input.tz)
    const today = localNow(this.#now(), input.tz).date
    const parsed = parseQuickAdd(input.text, { today })
    if (!parsed.title) throw new HearthError('bad_request', 'A task needs a title')
    return this.create(
      principal,
      {
        title: parsed.title,
        notes: input.notes,
        priority: parsed.priority,
        due: parsed.due,
        recur: parsed.recur,
        project: parsed.project ?? input.project,
        labels: parsed.labels,
        assignee: parsed.assignee,
        tz: input.tz,
        source: input.source,
        space: input.space,
      },
      via,
    )
  }

  /**
   * Changes the fields in `patch`. `opts.tz` is the member's zone (a timed `due` sent with it is
   * in that zone); `opts.baseBlobOid` asks for a 409 if the title or notes being replaced changed
   * since that version.
   */
  async update(
    principal: Principal,
    space: string,
    id: string,
    patch: TaskPatch,
    via?: string,
    opts: { tz?: string | undefined; baseBlobOid?: string | undefined } = {},
  ): Promise<TaskView> {
    this.#assertAccess(principal, space)
    const me = principal.email.toLowerCase()
    const tz = opts.tz ?? patch.tz
    if (tz) assertTimeZone(tz)
    const today = localNow(this.#now(), tz ?? 'UTC').date
    const fieldPatch: TaskPatch = { ...patch, ...(tz ? { tz } : {}) }
    let base: { title: string; notes: string } | null | undefined
    return this.#edit(principal, space, id, 'edit', via, async (cur, blobOid) => {
      if (opts.baseBlobOid && opts.baseBlobOid !== blobOid && touchesText(patch)) {
        base ??= await this.#textAt(space, opts.baseBlobOid)
        const titleChanged = patch.title !== undefined && base?.title !== cur.fm.title
        const notesChanged = patch.notes !== undefined && base?.notes !== cur.notes
        if (base === null || titleChanged || notesChanged) {
          throw new HearthError(
            'conflict',
            'Someone else changed this task’s title or notes; reload to see theirs',
          )
        }
      }
      const fields = this.#fields(principal, fieldPatch, cur.fm, today)
      // `tz` is the member's zone. It becomes the task's only with a timed due: one this patch
      // sets (in #fields), or the task's own timed due that has no zone yet.
      if (!('due' in fields) && tz && cur.fm.due && isTimed(cur.fm.due) && !cur.fm.tz) {
        fields.tz = tz
      }
      const assignee =
        'assignee' in fields ? (fields.assignee as string | undefined) : cur.fm.assignee
      this.#assertAssignable(space, assignee, me)
      let text = patchFrontmatter(cur.content, fields)
      if (patch.notes !== undefined && notesOf(patch.notes) !== cur.notes) {
        const { body } = parseFrontmatter(text)
        text = text.slice(0, text.length - body.length) + bodyFor(patch.notes)
      }
      return text === cur.content ? null : text
    })
  }

  /**
   * A recurring task moves to its next due date (in `tz`); any other is marked done. A task that
   * came from a meeting's action item ticks that line too, best effort.
   */
  async complete(
    principal: Principal,
    space: string,
    id: string,
    opts: { tz: string },
    via?: string,
  ): Promise<TaskView> {
    this.#assertAccess(principal, space)
    assertTimeZone(opts.tz)
    const now = this.#now()
    const today = localNow(now, opts.tz).date
    let changed = false
    const view = await this.#edit(principal, space, id, 'complete', via, async (cur) => {
      if (cur.fm.status === 'done') return null
      changed = true
      const next = cur.fm.recur ? nextDue(cur.fm.recur, cur.fm.due, today) : null
      return patchFrontmatter(
        cur.content,
        next
          ? { due: next }
          : { status: 'done', completed: isoNow(now), completed_by: principal.email.toLowerCase() },
      )
    })
    if (changed) await this.#tickMeetingItem(principal, view.source)
    return view
  }

  async reopen(principal: Principal, space: string, id: string, via?: string): Promise<TaskView> {
    this.#assertAccess(principal, space)
    let changed = false
    const view = await this.#edit(principal, space, id, 'reopen', via, async (cur) => {
      if (cur.fm.status === 'open') return null
      changed = true
      return patchFrontmatter(cur.content, {
        status: 'open',
        completed: undefined,
        completed_by: undefined,
      })
    })
    // A recurring task's line was ticked by an earlier completion, not this one: leave it.
    if (changed && !view.recur) await this.#tickMeetingItem(principal, view.source, 'reopen')
    return view
  }

  /** Moves the task to `.trash/<YYYY-MM-DD>/tasks/<id>.md`, like deleting a doc. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    await this.#trash(principal, space, id, 'delete', via)
  }

  /** One commit per space: the task is added to `toSpace`, then trashed where it was. */
  async move(
    principal: Principal,
    space: string,
    id: string,
    toSpace: string,
    via?: string,
  ): Promise<TaskView> {
    this.#assertAccess(principal, space)
    this.#assertAccess(principal, toSpace)
    if (toSpace === space) return this.get(principal, space, id)
    const path = taskPath(id)
    const file = await this.#read(space, id)
    this.#assertAssignable(toSpace, file.record.fm.assignee, principal.email.toLowerCase())
    if (await this.#exists(toSpace, path)) {
      throw new HearthError('conflict', `A task with id ${id} is already in ${toSpace}`)
    }
    let added = await this.#commit(principal, toSpace, {
      changes: [{ path, content: file.content }],
      verb: 'move',
      title: file.record.fm.title,
      via,
    })
    let content = file.content
    // The trash commit refuses a task that changed since it was copied; then the copy is brought
    // up to date and the trash tried again.
    await this.#trash(principal, space, id, 'move', via, async (current) => {
      if (current === content) return
      content = current
      added = await this.#commit(principal, toSpace, {
        changes: [{ path, content }],
        verb: 'move',
        title: parseTask(parseFrontmatter(content).data)?.title ?? id,
        via,
      })
    })
    return this.#viewOf(principal, toSpace, path, content, added)
  }

  /** Commits new task files (an import) in one commit. */
  async addMany(
    principal: Principal,
    space: string,
    tasks: Array<Omit<NewTask, 'createdBy'>>,
    message: string,
    via?: string,
  ): Promise<void> {
    this.#assertAccess(principal, space)
    if (tasks.length === 0) return
    const created = isoNow(this.#now())
    const changes = tasks.map((t) => {
      const file = newTaskFile({ ...t, createdBy: principal.email, created: t.created ?? created })
      return { path: file.path, content: file.text }
    })
    await this.#commit(principal, space, { changes, message, via })
  }

  // ── internals ────────────────────────────────────────────────────────────

  #assertAccess(principal: Principal, space: string): void {
    if (!this.#spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  #assertAssignable(space: string, assignee: string | undefined, me: string): void {
    if (space !== TEAM_SPACE && assignee && assignee !== me) {
      throw new HearthError(
        'bad_request',
        'A personal task can’t be assigned to someone else; move it to Team first',
      )
    }
  }

  async #personal(principal: Principal): Promise<Set<string>> {
    return personalOf(await this.#spaces.visibleSpaces(principal))
  }

  #records(spaces: Space[]): TaskRecord[] {
    const out: TaskRecord[] = []
    for (const s of spaces) {
      for (const row of this.#index.listFiles({ space: s.name, kind: 'task' })) {
        const id = taskIdOf(row.path)
        const fm = id ? parseTask(row.frontmatter) : null
        if (id && fm) out.push({ space: s.name, path: row.path, id, blobOid: row.blobOid, fm })
      }
    }
    return out
  }

  #searchPaths(q: string, spaces: Space[]): Set<string> {
    const hits = this.#index.search(q, {
      spaces: spaces.map((s) => s.name),
      kinds: ['task'],
      limit: 100,
    })
    return new Set(hits.map((h) => `${h.space}\n${h.path}`))
  }

  async #read(
    space: string,
    id: string,
  ): Promise<{ content: string; record: TaskRecord; notes: string }> {
    if (!TASK_ID.test(id)) throw new HearthError('not_found', `No task ${id} in ${space}`)
    const path = taskPath(id)
    let file: { content: string; blobOid: string }
    try {
      file = await this.#git.readFile(space, path)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') {
        throw new HearthError('not_found', `No task ${id} in ${space}`)
      }
      throw err
    }
    let parsed: ReturnType<typeof parseFrontmatter>
    try {
      parsed = parseFrontmatter(file.content)
    } catch (err) {
      if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
      throw err
    }
    const fm = parseTask(parsed.data)
    if (!fm) throw new HearthError('bad_request', `${path} in ${space} isn’t a task`)
    return {
      content: file.content,
      record: { space, path, id, blobOid: file.blobOid, fm },
      notes: notesOf(parsed.body),
    }
  }

  async #exists(space: string, path: string): Promise<boolean> {
    try {
      await this.#git.readFile(space, path)
      return true
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return false
      throw err
    }
  }

  /** Title and notes of an earlier version, or null when that blob isn't a task. */
  async #textAt(space: string, blobOid: string): Promise<{ title: string; notes: string } | null> {
    const content = await this.#git.readBlobText(space, blobOid)
    try {
      const parsed = parseFrontmatter(content)
      const fm = parseTask(parsed.data)
      return fm ? { title: fm.title, notes: notesOf(parsed.body) } : null
    } catch {
      return null
    }
  }

  /** Frontmatter keys for the fields `input` sets (undefined deletes a key). */
  #fields(
    principal: Principal,
    input: TaskPatch,
    current: TaskFrontmatter | null,
    today: string,
  ): Record<string, unknown> {
    const f: Record<string, unknown> = {}
    if (input.title !== undefined) {
      const title = singleLine(input.title)
      if (!title) throw new HearthError('bad_request', 'A task needs a title')
      f.title = title
    }
    if (input.priority !== undefined) {
      if (![1, 2, 3, 4].includes(input.priority)) {
        throw new HearthError('bad_request', 'Priority is 1 (most urgent) to 4 (none)')
      }
      f.priority = input.priority === 4 ? undefined : input.priority
    }
    if (input.due !== undefined) {
      if (input.due === null) {
        f.due = undefined
        f.tz = undefined
      } else {
        assertDue(input.due)
        f.due = input.due
        const tz = input.tz ?? current?.tz ?? 'UTC'
        assertTimeZone(tz)
        f.tz = isTimed(input.due) ? tz : undefined
      }
    }
    if (input.recur !== undefined) {
      if (input.recur === null || input.recur.trim() === '') {
        f.recur = undefined
      } else {
        const rule = normalizeRecurrence(input.recur)
        if (!rule) {
          throw new HearthError('bad_request', `Couldn’t understand the repeat “${input.recur}”`)
        }
        f.recur = rule
        const due = 'due' in f ? f.due : current?.due
        if (!due) f.due = firstOccurrence(rule, today)
      }
    }
    if (input.project !== undefined) f.project = input.project?.trim() || undefined
    if (input.labels !== undefined) {
      const labels = [...new Set(input.labels.map((l) => l.trim()).filter(Boolean))]
      f.labels = labels.length > 0 ? labels : undefined
    }
    if (input.assignee !== undefined) {
      f.assignee = input.assignee
        ? resolveAssignee(input.assignee, this.people(principal))
        : undefined
    }
    if (input.order !== undefined) f.order = input.order ?? undefined
    if (input.source !== undefined) f.source = input.source
    return f
  }

  /** Read → edit → commit, unchanged-guarded and retried on a concurrent change. */
  async #edit(
    principal: Principal,
    space: string,
    id: string,
    verb: string,
    via: string | undefined,
    edit: (
      cur: { content: string; fm: TaskFrontmatter; notes: string },
      blobOid: string,
    ) => Promise<string | null>,
  ): Promise<TaskView> {
    for (let attempt = 1; ; attempt++) {
      const file = await this.#read(space, id)
      const cur = { content: file.content, fm: file.record.fm, notes: file.notes }
      let text: string | null
      try {
        text = await edit(cur, file.record.blobOid)
      } catch (err) {
        if (err instanceof FrontmatterError) throw new HearthError('bad_request', err.message)
        throw err
      }
      if (text === null) {
        return toView(file.record, file.notes, principal, await this.#personal(principal))
      }
      const title = parseTask(parseFrontmatter(text).data)?.title ?? cur.fm.title
      try {
        const result = await this.#commit(principal, space, {
          changes: [{ path: file.record.path, content: text }],
          verb,
          title,
          via,
          unchanged: { path: file.record.path, blobOid: file.record.blobOid },
        })
        return this.#viewOf(principal, space, file.record.path, text, result)
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
      }
    }
  }

  /**
   * Moves the task file into the trash in one commit, retried on a concurrent change.
   * `beforeCommit` sees the content about to be trashed (a move keeps its copy up to date).
   */
  async #trash(
    principal: Principal,
    space: string,
    id: string,
    verb: 'delete' | 'move',
    via: string | undefined,
    beforeCommit?: (content: string) => Promise<void>,
  ): Promise<CommitResult> {
    const day = isoNow(this.#now()).slice(0, 10)
    for (let attempt = 1; ; attempt++) {
      const file = await this.#read(space, id)
      await beforeCommit?.(file.content)
      let trashPath = `${SPACE_LAYOUT.trash}/${day}/${file.record.path}`
      if (await this.#exists(space, trashPath)) {
        trashPath = `${SPACE_LAYOUT.trash}/${day}-${id.slice(-8)}/${file.record.path}`
      }
      try {
        return await this.#commit(principal, space, {
          changes: [
            { path: trashPath, content: file.content },
            { path: file.record.path, content: null },
          ],
          verb,
          title: file.record.fm.title,
          via,
          unchanged: { path: file.record.path, blobOid: file.record.blobOid },
        })
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict') || attempt >= WRITE_ATTEMPTS) {
          throw err
        }
      }
    }
  }

  async #commit(
    principal: Principal,
    space: string,
    args: {
      changes: Array<{ path: string; content: string | null }>
      verb?: string
      title?: string
      message?: string
      via: string | undefined
      unchanged?: { path: string; blobOid: string }
    },
  ): Promise<CommitResult> {
    const message = withVia(
      args.message ??
        formatCommitMessage({ app: 'tasks', verb: args.verb ?? 'edit', title: args.title ?? '' }),
      args.via,
    )
    const result = await this.#git.commit(space, {
      changes: args.changes,
      author: { name: principal.name, email: principal.email },
      message,
      ...(args.unchanged ? { unchanged: args.unchanged } : {}),
    })
    await this.#syncer.afterHeadChanged(space)
    return result
  }

  async #viewOf(
    principal: Principal,
    space: string,
    path: string,
    text: string,
    result: CommitResult,
  ): Promise<TaskView> {
    if (result.status === 'conflict') throw new HearthError('internal', 'Unexpected conflict')
    const parsed = parseFrontmatter(text)
    const fm = parseTask(parsed.data)
    const id = taskIdOf(path)
    if (!fm || !id) throw new HearthError('internal', `${path} isn’t a task after writing it`)
    return toView(
      { space, path, id, blobOid: result.blobOid, fm },
      notesOf(parsed.body),
      principal,
      await this.#personal(principal),
    )
  }

  /**
   * Ticks (or, reopening, unticks) the meeting line a task came from. A note that moved on is
   * logged and left alone.
   */
  async #tickMeetingItem(
    principal: Principal,
    source: TaskSource | null,
    verb: 'complete' | 'reopen' = 'complete',
  ): Promise<void> {
    if (source?.kind !== 'meeting' || !source.space || !source.path || !source.line) return
    if (!source.text || !this.#spaces.canAccess(principal, source.space)) return
    try {
      await (verb === 'reopen' ? reopenActionItem : completeActionItem)(
        {
          git: this.#git,
          afterCommit: async (space) => {
            await this.#syncer.afterHeadChanged(space)
          },
        },
        principal,
        { space: source.space, path: source.path, line: source.line, text: source.text },
      )
    } catch (err) {
      this.#log(
        `tasks: couldn't tick ${source.space}:${source.path}#L${source.line}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

function personalOf(spaces: Space[]): Set<string> {
  return new Set(spaces.filter((s) => s.kind === 'personal').map((s) => s.name))
}

function touchesText(patch: TaskPatch): boolean {
  return patch.title !== undefined || patch.notes !== undefined
}

/** `readFile` from the index's body of each file: the text after the frontmatter. */
function indexReader(index: Pick<Index, 'bodyAt'>): Pick<GitStore, 'readFile'> {
  return {
    readFile: async (space, path) => {
      const at = index.bodyAt(space, path)
      if (at === null) throw new HearthError('not_found', `${path} is not indexed`)
      // Blank lines where the frontmatter was, so to-do line numbers are the file's own.
      const content = '\n'.repeat(at.line - 1) + at.body
      return { content, blobOid: '' } as Awaited<ReturnType<GitStore['readFile']>>
    },
  }
}
