// MSW routes for `/api/tasks` (ARCHITECTURE §12.3), in memory, shaped exactly like the server's
// TaskView (§12.2). The quick-add parser, recurrence and dates are the real ones from
// @hearth/format, so the mock and the server agree on what a line means.

import {
  addDays,
  dueDate,
  dueInstant,
  firstOccurrence,
  isTimed,
  localNow,
  newId,
  nextDue,
  normalizeRecurrence,
  parseFrontmatter,
  parseQuickAdd,
  type TaskSource,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import { memberTimeZone, type Priority, type TaskInput, type TaskView } from '../api/tasks'
import type { MeetingActionItems, ServerEvent } from '../api/types'
import { blobOid, type FakeRepo, type FakeUser } from './fakeRepo'
import { ADA, PRIYA, SAM } from './seed'

type StoredTask = Omit<TaskView, 'mine' | 'blobOid' | 'path' | 'dueAt'>

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

const handleOf = (email: string) =>
  (email.split('@')[0] ?? email).toLowerCase().replace(/[^a-z0-9-]/g, '-')

const BASE_PEOPLE = [ADA, PRIYA, SAM].map((a) => ({
  email: a.email,
  name: a.name,
  handle: handleOf(a.email),
}))

function zoneOk(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export class FakeTasks {
  readonly tasks = new Map<string, StoredTask>()
  /** Meeting lines ticked through `/api/meetings/action-items/done`. */
  readonly ticked = new Set<string>()
  /** Members whose tasks are seeded (or who asked not to be: tests add themselves first). */
  readonly seeded = new Set<string>()
  /** Title and notes of every version handed out, by blob id (the server reads old blobs). */
  readonly versions = new Map<string, { title: string; notes: string }>()
  /** Set by tests: the next write fails with a 500. */
  failNext = false
  /** What `/ramble` answers; tests replace it. */
  ramble: { transcript: string; lines: string[] } = {
    transcript:
      'Call Sam tomorrow at 3pm about the pilot budget. Book flights to Boston next week, priority two. Also review the audit draft for the compliance project.',
    lines: [
      'Call Sam about the pilot budget tomorrow 3pm',
      'Book flights to Boston next week p2',
      'Review the audit draft #Compliance',
    ],
  }

  constructor(readonly repo: FakeRepo) {}

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  view(t: StoredTask, user: FakeUser): TaskView {
    const mine =
      t.space === user.handle ||
      (t.space === 'team' &&
        (t.assignee === user.email || (!t.assignee && t.createdBy === user.email)))
    const zone = t.tz ?? 'UTC'
    const oid = blobOid(JSON.stringify(t))
    this.versions.set(oid, { title: t.title, notes: t.notes })
    return {
      ...t,
      path: `tasks/${t.id}.md`,
      blobOid: oid,
      dueAt: t.due && isTimed(t.due) ? dueInstant(t.due, zone) : null,
      mine,
    }
  }

  add(task: Partial<StoredTask> & { title: string; space: string; createdBy: string }): StoredTask {
    const stored: StoredTask = {
      id: task.id ?? newId(),
      title: task.title,
      notes: task.notes ?? '',
      status: task.status ?? 'open',
      priority: task.priority ?? 4,
      due: task.due ?? null,
      tz: task.tz ?? null,
      recur: task.recur ?? null,
      project: task.project ?? null,
      labels: task.labels ?? [],
      assignee: task.assignee ?? null,
      createdBy: task.createdBy,
      created: task.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      completed: task.completed ?? null,
      completedBy: task.completedBy ?? null,
      order: task.order ?? null,
      source: task.source ?? null,
      space: task.space,
    }
    this.tasks.set(this.key(stored.space, stored.id), stored)
    return stored
  }

  /** Open `- [ ]` lines of the meeting notes in `spaces`, newest first, as the server lists them. */
  actionItems(spaces: string[]): MeetingActionItems[] {
    const out: MeetingActionItems[] = []
    for (const space of spaces) {
      const files = this.repo.space(space).files
      for (const [path, text] of files) {
        if (
          !path.startsWith('meetings/') ||
          !path.endsWith('.md') ||
          path.endsWith('.transcript.md')
        )
          continue
        const fm = parseFrontmatter(text)
        const data = fm.data as { title?: string; date?: string }
        const items: Array<{ line: number; text: string }> = []
        text.split('\n').forEach((line, i) => {
          const m = /^\s*- \[ \] (.+)$/.exec(line)
          if (m?.[1] && !this.ticked.has(`${space}:${path}:${i + 1}`))
            items.push({ line: i + 1, text: m[1].trim() })
        })
        if (items.length > 0) {
          out.push({
            space,
            path,
            title: data.title ?? path,
            date: String(data.date ?? ''),
            items,
          })
        }
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date))
  }
}

/** Seeds a realistic list for the member around today (in their zone). */
export function seedTasks(fake: FakeTasks, user: FakeUser, today: string): void {
  const me = user.email
  const personal = user.handle
  const at = (days: number, hhmm?: string) => `${addDays(today, days)}${hhmm ? `T${hhmm}` : ''}`
  const tz = 'America/New_York'
  const created = (n: number) =>
    new Date(Date.UTC(2026, 10, 1, 12, n)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const p = (n: number) => n as Priority
  fake.add({
    space: personal,
    createdBy: me,
    created: created(1),
    title: 'Renew the lab safety certificate',
    due: at(-2),
    priority: p(2),
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(2),
    title: 'Call Sam about the pilot budget',
    due: at(0, '15:00'),
    tz,
    priority: p(1),
    labels: ['calls'],
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(3),
    title: 'Water the office plants',
    due: at(0),
    recur: 'every week',
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(4),
    title: 'Read the biosafety audit draft',
    notes: 'Priya sent it Tuesday.\nFocus on section 4, the sample chain of custody.',
    priority: p(3),
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(5),
    title: 'Book flights for the Boston visit',
    due: at(3),
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(6),
    title: 'Sort out October expense receipts',
    labels: ['admin'],
  })
  fake.add({
    space: personal,
    createdBy: me,
    created: created(7),
    title: 'Send the board deck',
    status: 'done',
    completed: new Date(Date.now() - 86_400_000).toISOString(),
    completedBy: me,
  })
  fake.add({
    space: 'team',
    createdBy: me,
    created: created(8),
    title: 'Ship the Hearth Tasks beta',
    project: 'Launch',
    assignee: me,
    due: at(5),
    priority: p(1),
  })
  fake.add({
    space: 'team',
    createdBy: me,
    created: created(9),
    title: 'Write the launch announcement',
    project: 'Launch',
    assignee: PRIYA.email,
    due: at(6),
  })
  fake.add({
    space: 'team',
    createdBy: me,
    created: created(10),
    title: 'Record a demo clip',
    project: 'Launch',
    labels: ['video'],
  })
  fake.add({
    space: 'team',
    createdBy: SAM.email,
    created: created(11),
    title: 'Order new lab notebooks',
    project: 'Ops',
    assignee: me,
    due: at(20),
  })
  fake.add({
    space: 'team',
    createdBy: SAM.email,
    created: created(12),
    title: 'Plan the offsite agenda',
    project: 'Ops',
    assignee: SAM.email,
    due: at(9),
  })
}

export interface TaskHandlerDeps {
  tasks: FakeTasks
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  broadcast: (event: ServerEvent) => void
  /** Seed the member's tasks the first time they show up. */
  seeded: boolean
}

export function taskHandlers(deps: TaskHandlerDeps): AnyHandler[] {
  const { tasks: fake, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const visible = (user: FakeUser) => ['team', user.handle]
  const canAccess = (user: FakeUser, space: string) => visible(user).includes(space)

  const people = (user: FakeUser) =>
    BASE_PEOPLE.some((p) => p.email === user.email)
      ? BASE_PEOPLE
      : [...BASE_PEOPLE, { email: user.email, name: user.name, handle: user.handle }]

  const resolve = (user: FakeUser, name: string | null | undefined): string | null | Response => {
    if (!name) return null
    const n = name.toLowerCase()
    const all = people(user)
    const hit =
      all.find((p) => p.handle === n) ??
      all.find((p) => p.email === n) ??
      all.find((p) => p.email.split('@')[0] === n)
    return hit ? hit.email : error(400, 'bad_request', `No member called ${name}`)
  }

  const changed = (space: string, id: string) =>
    deps.broadcast({ type: 'changed', space, headOid: newId(), paths: [`tasks/${id}.md`] })

  const authed =
    (
      fn: (args: {
        request: Request
        user: FakeUser
        params: Record<string, unknown>
        url: URL
      }) => Response | Promise<Response>,
    ) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      if (deps.seeded && !fake.seeded.has(user.email)) {
        fake.seeded.add(user.email)
        seedTasks(fake, user, localNow(new Date(), memberTimeZone()).date)
      }
      return fn({ request, user, params, url: new URL(request.url) })
    }

  const write = () => {
    if (!fake.failNext) return null
    fake.failNext = false
    return error(500, 'server_error', 'The server fell over')
  }

  /** The task a `/:space/:id` route names, or the error response. */
  const one = (user: FakeUser, params: Record<string, unknown>): StoredTask | Response => {
    const space = String(params.space)
    if (!canAccess(user, space)) return error(403, 'forbidden', 'You cannot open this space')
    const task = fake.tasks.get(fake.key(space, String(params.id)))
    return task ?? error(404, 'not_found', 'No such task')
  }

  const visibleTasks = (user: FakeUser) =>
    [...fake.tasks.values()].filter((t) => canAccess(user, t.space))

  const sortOpen = (a: TaskView, b: TaskView) => {
    if (a.due !== b.due) {
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due < b.due ? -1 : 1
    }
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.order !== b.order) {
      if (a.order === null) return 1
      if (b.order === null) return -1
      return a.order - b.order
    }
    return a.created.localeCompare(b.created)
  }

  /** Applies a TaskInput patch; a Response when it's refused. */
  const applyPatch = (
    user: FakeUser,
    task: StoredTask,
    patch: Partial<TaskInput> & { tz?: string },
  ): Response | null => {
    if (patch.tz !== undefined && !zoneOk(patch.tz))
      return error(400, 'bad_request', 'Unknown time zone')
    if (patch.title !== undefined)
      task.title = patch.title.replace(/\s+/g, ' ').trim() || task.title
    if (patch.notes !== undefined) task.notes = patch.notes
    if (patch.priority !== undefined) task.priority = patch.priority
    // `tz` is the member's zone: it's "today", and the zone of a timed due sent with it (or of
    // the task's timed due that has none yet).
    if (patch.due !== undefined) {
      task.due = patch.due
      task.tz = patch.due && isTimed(patch.due) ? (patch.tz ?? task.tz ?? 'UTC') : null
    } else if (patch.tz && task.due && isTimed(task.due) && !task.tz) {
      task.tz = patch.tz
    }
    if (patch.recur !== undefined) {
      if (patch.recur === null) task.recur = null
      else {
        const rule = normalizeRecurrence(patch.recur)
        if (!rule) return error(400, 'bad_request', `Can’t understand “${patch.recur}”`)
        task.recur = rule
        if (!task.due)
          task.due = firstOccurrence(rule, localNow(new Date(), patch.tz ?? 'UTC').date)
      }
    }
    if (patch.project !== undefined) task.project = patch.project?.trim() || null
    if (patch.labels !== undefined) task.labels = patch.labels
    if (patch.order !== undefined) task.order = patch.order
    if (patch.source !== undefined) task.source = patch.source
    if (patch.assignee !== undefined) {
      const email = resolve(user, patch.assignee)
      if (email instanceof Response) return email
      if (email && email !== user.email && task.space !== 'team') {
        return error(400, 'bad_request', 'Only a team task can be assigned to someone else')
      }
      task.assignee = email
    }
    return null
  }

  const create = (
    user: FakeUser,
    input: Partial<TaskInput> & { title: string; space?: string; tz?: string },
  ): StoredTask | Response => {
    const assignee = resolve(user, input.assignee)
    if (assignee instanceof Response) return assignee
    const space = input.space ?? (assignee && assignee !== user.email ? 'team' : user.handle)
    if (!canAccess(user, space)) return error(403, 'forbidden', 'You cannot open this space')
    if (assignee && assignee !== user.email && space !== 'team') {
      return error(400, 'bad_request', 'Only a team task can be assigned to someone else')
    }
    const task = fake.add({ title: input.title, space, createdBy: user.email })
    const refused = applyPatch(user, task, { ...input, assignee: assignee ?? null })
    if (refused) {
      fake.tasks.delete(fake.key(task.space, task.id))
      return refused
    }
    if (!task.title.trim()) task.title = 'Untitled task'
    changed(space, task.id)
    return task
  }

  return [
    http.get(
      '/api/tasks',
      authed(({ user, url }) => {
        const q = url.searchParams
        const status = q.get('status') ?? 'open'
        const mine = q.get('mine')
        const limit = Math.min(500, Number(q.get('limit') ?? 500) || 500)
        const views = visibleTasks(user)
          .map((t) => fake.view(t, user))
          .filter((t) => status === 'all' || t.status === status)
          // As the server: mine=false is no filter, and an empty project is the Inbox.
          .filter((t) => (mine !== 'true' && mine !== '1') || t.mine)
          .filter((t) => !q.has('project') || t.project === (q.get('project') || null))
          .filter((t) => !q.get('space') || t.space === q.get('space'))
          .filter((t) => {
            const before = q.get('due_before')
            return !before || (t.due !== null && dueDate(t.due) <= before)
          })
          .filter((t) => {
            const after = q.get('due_after')
            return !after || (t.due !== null && dueDate(t.due) >= after)
          })
          .filter((t) => {
            // Only done tasks completed before it are dropped.
            const since = q.get('done_since')
            return !since || t.status !== 'done' || (t.completed ?? '') >= since
          })
          .filter((t) => {
            const text = q.get('q')?.toLowerCase()
            return !text || `${t.title}\n${t.notes}`.toLowerCase().includes(text)
          })
        views.sort(
          status === 'done'
            ? (a, b) => (b.completed ?? '').localeCompare(a.completed ?? '')
            : sortOpen,
        )
        return HttpResponse.json({ tasks: views.slice(0, limit) })
      }),
    ),

    http.get(
      '/api/tasks/projects',
      authed(({ user }) => {
        const counts = new Map<string, { space: string; name: string; open: number }>()
        for (const t of visibleTasks(user)) {
          if (!t.project) continue
          const k = `${t.space}\u0000${t.project}`
          const row = counts.get(k) ?? { space: t.space, name: t.project, open: 0 }
          if (t.status === 'open') row.open += 1
          counts.set(k, row)
        }
        return HttpResponse.json([...counts.values()])
      }),
    ),

    http.get(
      '/api/tasks/people',
      authed(({ user }) => HttpResponse.json(people(user))),
    ),

    http.get(
      '/api/tasks/from-meetings',
      authed(({ user }) => {
        const converted = new Set(
          visibleTasks(user)
            .filter((t) => t.source?.kind === 'meeting')
            .map((t) => `${t.source?.space}:${t.source?.path}:${t.source?.text}`),
        )
        const list = fake
          .actionItems(visible(user))
          .map((m) => ({
            ...m,
            items: m.items.filter((i) => !converted.has(`${m.space}:${m.path}:${i.text}`)),
          }))
          .filter((m) => m.items.length > 0)
        return HttpResponse.json(list)
      }),
    ),

    // Records the tick for from-meetings, then lets the meetings mock answer.
    http.post('/api/meetings/action-items/done', async ({ request }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { space?: string; path?: string; line?: number } | null
      if (body?.space && body.path && body.line)
        fake.ticked.add(`${body.space}:${body.path}:${body.line}`)
      return undefined
    }),

    http.post(
      '/api/tasks',
      authed(async ({ request, user }) => {
        const failed = write()
        if (failed) return failed
        const body = (await request.json()) as TaskInput & { space?: string; tz?: string }
        if (!body?.title) return error(400, 'bad_request', 'A task needs a title')
        const task = create(user, body)
        if (task instanceof Response) return task
        return HttpResponse.json(fake.view(task, user), { status: 201 })
      }),
    ),

    http.post(
      '/api/tasks/quick',
      authed(async ({ request, user }) => {
        const failed = write()
        if (failed) return failed
        const body = (await request.json()) as {
          text: string
          tz: string
          space?: string
          project?: string
          source?: TaskSource
        }
        if (!zoneOk(body.tz)) return error(400, 'bad_request', 'Unknown time zone')
        const parsed = parseQuickAdd(body.text ?? '', { today: localNow(new Date(), body.tz).date })
        if (!parsed.title) return error(400, 'bad_request', 'A task needs a title')
        const input: Partial<TaskInput> & { title: string; space?: string; tz: string } = {
          title: parsed.title,
          tz: body.tz,
          labels: parsed.labels,
          source: body.source ?? { kind: 'manual' },
        }
        if (parsed.due) input.due = parsed.due
        if (parsed.recur) input.recur = parsed.recur
        if (parsed.priority) input.priority = parsed.priority as Priority
        if (parsed.project ?? body.project) input.project = parsed.project ?? body.project ?? null
        if (parsed.assignee) input.assignee = parsed.assignee
        if (body.space) input.space = body.space
        const task = create(user, input)
        if (task instanceof Response) return task
        return HttpResponse.json(fake.view(task, user), { status: 201 })
      }),
    ),

    http.post(
      '/api/tasks/ramble',
      authed(async ({ request, url }) => {
        const type = (request.headers.get('content-type') ?? '').split(';')[0]
        if (!['audio/webm', 'audio/mp4', 'audio/wav'].includes(type ?? '')) {
          return error(415, 'bad_request', 'Send audio/webm, audio/mp4 or audio/wav')
        }
        await request.arrayBuffer()
        const today = localNow(new Date(), url.searchParams.get('tz') || 'UTC').date
        return HttpResponse.json({
          transcript: fake.ramble.transcript,
          tasks: fake.ramble.lines.map((line) => parseQuickAdd(line, { today })),
        })
      }),
    ),

    http.post(
      '/api/tasks/import/todoist',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as {
          token?: string
          csv?: string
          projectName?: string
        }
        const already = new Set(
          visibleTasks(user)
            .filter((t) => t.source?.kind === 'import')
            .map((t) => t.source?.ref),
        )
        const rows: Array<{
          ref: string
          title: string
          project: string | null
          priority: Priority
        }> = []
        if (body.token) {
          if (body.token === 'bad') return error(400, 'bad_request', 'Todoist refused that token')
          rows.push(
            { ref: 'td-1', title: 'Renew passport', project: 'Errands', priority: 2 },
            { ref: 'td-2', title: 'Pick up dry cleaning', project: 'Errands', priority: 4 },
            { ref: 'td-3', title: 'Finish “The Gene”', project: 'Reading', priority: 4 },
          )
        } else if (body.csv) {
          const project = body.projectName ?? 'Imported'
          body.csv
            .split(/\r?\n/)
            .slice(1)
            .forEach((line, i) => {
              const [type, content, , priority] = line.split(',')
              if (type === 'task' && content) {
                rows.push({
                  ref: `csv-${project}-${i}`,
                  title: content,
                  project,
                  // Todoist's CSV writes PRIORITY 1 for p1.
                  priority: Math.min(4, Math.max(1, Number(priority) || 4)) as Priority,
                })
              }
            })
        } else return error(400, 'bad_request', 'Send a token or a CSV file')
        let imported = 0
        let skipped = 0
        const projects = new Set<string>()
        for (const row of rows) {
          if (already.has(row.ref)) {
            skipped += 1
            continue
          }
          fake.add({
            space: user.handle,
            createdBy: user.email,
            title: row.title,
            project: row.project,
            priority: row.priority,
            source: { kind: 'import', from: 'todoist', ref: row.ref },
          })
          if (row.project) projects.add(row.project)
          imported += 1
        }
        if (imported > 0) changed(user.handle, 'import')
        return HttpResponse.json({ imported, skipped, projects: [...projects] })
      }),
    ),

    http.get(
      '/api/tasks/:space/:id',
      authed(({ user, params }) => {
        const task = one(user, params)
        return task instanceof Response ? task : HttpResponse.json(fake.view(task, user))
      }),
    ),

    http.patch(
      '/api/tasks/:space/:id',
      authed(async ({ request, user, params }) => {
        const task = one(user, params)
        if (task instanceof Response) return task
        const failed = write()
        if (failed) return failed
        const patch = (await request.json()) as Partial<TaskInput> & {
          tz?: string
          baseBlobOid?: string
        }
        const { baseBlobOid, ...fields } = patch
        // As the server: 409 only when the title or notes being set changed since that version.
        if (baseBlobOid && baseBlobOid !== fake.view(task, user).blobOid) {
          const base = fake.versions.get(baseBlobOid)
          if (
            (fields.title !== undefined || fields.notes !== undefined) &&
            (!base ||
              (fields.title !== undefined && base.title !== task.title) ||
              (fields.notes !== undefined && base.notes !== task.notes))
          ) {
            return error(409, 'conflict', 'Someone changed this task while you were editing it')
          }
        }
        const copy = { ...task, labels: [...task.labels] }
        const refused = applyPatch(user, copy, fields)
        if (refused) return refused
        fake.tasks.set(fake.key(copy.space, copy.id), copy)
        changed(copy.space, copy.id)
        return HttpResponse.json(fake.view(copy, user))
      }),
    ),

    http.post(
      '/api/tasks/:space/:id/complete',
      authed(async ({ request, user, params }) => {
        const task = one(user, params)
        if (task instanceof Response) return task
        const failed = write()
        if (failed) return failed
        const { tz } = (await request.json().catch(() => ({}))) as { tz?: string }
        const today = localNow(new Date(), zoneOk(tz) ? tz : 'UTC').date
        const next = task.recur ? nextDue(task.recur, task.due ?? undefined, today) : null
        if (next) task.due = next
        else {
          task.status = 'done'
          task.completed = new Date().toISOString()
          task.completedBy = user.email
        }
        if (
          task.source?.kind === 'meeting' &&
          task.source.space &&
          task.source.path &&
          task.source.line
        ) {
          fake.ticked.add(`${task.source.space}:${task.source.path}:${task.source.line}`)
        }
        changed(task.space, task.id)
        return HttpResponse.json(fake.view(task, user))
      }),
    ),

    http.post(
      '/api/tasks/:space/:id/reopen',
      authed(({ user, params }) => {
        const task = one(user, params)
        if (task instanceof Response) return task
        const failed = write()
        if (failed) return failed
        task.status = 'open'
        task.completed = null
        task.completedBy = null
        changed(task.space, task.id)
        return HttpResponse.json(fake.view(task, user))
      }),
    ),

    http.post(
      '/api/tasks/:space/:id/move',
      authed(async ({ request, user, params }) => {
        const task = one(user, params)
        if (task instanceof Response) return task
        const { toSpace } = (await request.json()) as { toSpace: string }
        if (!canAccess(user, toSpace)) return error(403, 'forbidden', 'You cannot open this space')
        if (toSpace !== 'team' && task.assignee && task.assignee !== user.email) {
          return error(400, 'bad_request', 'Only a team task can be assigned to someone else')
        }
        fake.tasks.delete(fake.key(task.space, task.id))
        const moved = { ...task, space: toSpace }
        fake.tasks.set(fake.key(toSpace, moved.id), moved)
        changed(task.space, task.id)
        changed(toSpace, moved.id)
        return HttpResponse.json(fake.view(moved, user))
      }),
    ),

    http.delete(
      '/api/tasks/:space/:id',
      authed(({ user, params }) => {
        const task = one(user, params)
        if (task instanceof Response) return task
        const failed = write()
        if (failed) return failed
        fake.tasks.delete(fake.key(task.space, task.id))
        changed(task.space, task.id)
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
