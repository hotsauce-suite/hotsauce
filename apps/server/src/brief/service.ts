import { createHash } from 'node:crypto'
import { parseFrontmatter, parseTranscript, transcriptPathFor } from '@hearth/format'
import { stringify as toYaml } from 'yaml'
import type { Authenticator, Principal } from '../auth/index.js'
import type { Checkins } from '../checkins/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import { KeyedMutex } from '../git/mutex.js'
import type { Index } from '../index/index.js'
import { matchesPerson } from '../meetings/list.js'
import type { LLM } from '../meetings/llm/types.js'
import { zonedParts } from '../meetings/zoned-time.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { Tasks, TaskView } from '../tasks/index.js'
import type { BriefMembers } from './members.js'
import {
  type BriefCheckin,
  type BriefMeeting,
  type BriefTask,
  buildBriefPrompt,
  cleanBrief,
} from './prompt.js'

/** Where a member's brief and their corrections live, in their personal space. */
export const BRIEF_PATH = '.hearth/brief/brief.md'
export const BRIEF_NOTES_PATH = '.hearth/brief/notes.md'

/** How far back the brief reads meetings, and how many at most. */
export const BRIEF_WINDOW_DAYS = 30
const MAX_MEETINGS = 40
const NOTE_CHARS = 4_000
const SAID_CHARS = 1_500
/** The whole material budget, in characters (about 45k tokens); the oldest meetings go first. */
const MATERIAL_CHARS = 180_000
const MAX_OPEN_TASKS = 60
const MAX_DONE_TASKS = 30
const DONE_WINDOW_DAYS = 14
/** Their own check-in answers in the window, each cut to this many characters. */
const MAX_CHECKINS = 10
const CHECKIN_CHARS = 1_500
export const MAX_NOTES_CHARS = 20_000
const TICK_MS = 15 * 60_000
/** Bumped when the prompt changes, so every brief is rewritten the next night. */
const PROMPT_VERSION = 1
/** A nightly failure is tried again on later ticks, up to this many times a night. */
const NIGHTLY_ATTEMPTS = 3
/** Forced rewrites (the button, the API) per member: at most one a minute and this many a day. */
const FORCED_PER_DAY = 20

export interface AgentBrief {
  space: string
  path: string
  /** The brief's Markdown body, without frontmatter. */
  body: string
  /** ISO instant it was written. */
  generated: string
  model: string
  meetings: number
  tasks: number
}

export interface BriefState {
  brief: AgentBrief | null
  /** The member's own corrections, verbatim. */
  notes: string
}

export type RefreshStatus = 'written' | 'unchanged' | 'empty'

type BriefDeps = {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'listFiles'>
  spaces: Pick<SpaceService, 'visibleSpaces' | 'ensurePersonalSpace'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  tasks: Pick<Tasks, 'list'>
  /** Check-ins (§24): the member's own answers; absent leaves them out. */
  checkins?: Pick<Checkins, 'answersSince'> | null
  llm: LLM
  model: string
  members: BriefMembers
  auth: Pick<Authenticator, 'principalForUser'>
  /** The organization's name, for the prompt. */
  org: string
  /** Local hour (0–23) after which the nightly brief is due. */
  hour: number
  /** Least time between two forced rewrites by one member. */
  forcedGapMs: number
  /** False turns the nightly pass off (no language model configured). */
  nightly: boolean
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Agent briefs (ARCHITECTURE §13): a nightly snapshot of each member's work, written by the
 * language model from their recent meetings, tasks and their own corrections, kept as a file in
 * their personal space, and handed to agents over MCP.
 */
export class AgentBriefs {
  readonly #d: BriefDeps
  readonly #now: () => Date
  readonly #log: (message: string) => void
  readonly #lock = new KeyedMutex()
  #timer: ReturnType<typeof setInterval> | null = null
  #catchUp: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #stopping = false
  readonly #failures = new Map<string, number>()
  readonly #forced = new Map<string, number[]>()

  constructor(deps: BriefDeps) {
    this.#d = deps
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.error
  }

  /** Records the member for the nightly pass, with their zone when the browser says it. */
  async touch(principal: Principal, tz?: string): Promise<void> {
    if (principal.userId === '') return
    await this.#d.members.touch(principal.userId, principal.email, validZone(tz))
  }

  async read(principal: Principal): Promise<BriefState> {
    const space = await this.#personal(principal)
    const [brief, notes] = await Promise.all([
      this.#readBrief(space),
      this.#readText(space, BRIEF_NOTES_PATH),
    ])
    return { brief: publicBrief(brief), notes: notes?.content ?? '' }
  }

  /**
   * Writes the member's brief now. Unless `force`, nothing is written when the material is the
   * same as last time. `empty` when there are no recent meetings and no tasks to write from.
   */
  async refresh(
    principal: Principal,
    opts: { force?: boolean; via?: string } = {},
  ): Promise<{ status: RefreshStatus; state: BriefState }> {
    if (opts.force) this.#allowForced(principal.email)
    return this.#lock.run(principal.email, async () => {
      const space = await this.#personal(principal)
      const status = await this.#write(principal, space, opts)
      return { status, state: await this.read(principal) }
    })
  }

  async saveNotes(principal: Principal, text: string, via?: string): Promise<void> {
    if (text.length > MAX_NOTES_CHARS) {
      throw new HearthError('bad_request', `Notes are limited to ${MAX_NOTES_CHARS} characters`)
    }
    const space = await this.#personal(principal)
    await this.#lock.run(principal.email, async () => {
      const current = await this.#readText(space, BRIEF_NOTES_PATH)
      if ((current?.content ?? '') === text) return
      await this.#commit(principal, space, BRIEF_NOTES_PATH, text, 'correct', via)
    })
  }

  // ── nightly ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.#timer || !this.#d.nightly) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
    // A server that was down at the nightly hour catches up shortly after starting.
    this.#catchUp = setTimeout(() => void this.tick(), 60_000)
    this.#catchUp.unref()
  }

  /** Stops the nightly pass between members, so a deploy waits for one brief at most. */
  async close(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#catchUp) clearTimeout(this.#catchUp)
    this.#timer = null
    this.#catchUp = null
    await this.#running
  }

  /** One nightly pass; a pass still running is joined rather than doubled. */
  tick(): Promise<void> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #tick(): Promise<void> {
    const now = this.#now()
    for (const member of await this.#d.members.list()) {
      if (this.#stopping) return
      if (!isDue(member.checkedAt, now, member.tz, this.#d.hour)) continue
      try {
        const principal = await this.#d.auth.principalForUser(member.userId)
        if (!principal) {
          await this.#d.members.remove(member.userId)
          continue
        }
        await this.#d.spaces.ensurePersonalSpace(principal)
        await this.refresh(principal)
        this.#failures.delete(member.userId)
      } catch (err) {
        const failures = (this.#failures.get(member.userId) ?? 0) + 1
        this.#log(
          `brief: nightly brief for ${member.email} failed (${failures}): ${errorText(err)}`,
        )
        // Tried again on the next ticks (a model outage at 4 AM shouldn't cost a day), then left
        // for tomorrow night or the member's own click.
        if (failures < NIGHTLY_ATTEMPTS) {
          this.#failures.set(member.userId, failures)
          continue
        }
        this.#failures.delete(member.userId)
      }
      await this.#d.members.markChecked(member.userId, now)
    }
  }

  // ── writing ──────────────────────────────────────────────────────────────

  async #write(
    principal: Principal,
    space: string,
    opts: { force?: boolean; via?: string },
  ): Promise<RefreshStatus> {
    const now = this.#now()
    const material = await this.#material(principal, space, now)
    if (
      material.meetings.length === 0 &&
      material.tasks.length === 0 &&
      material.checkins.length === 0
    )
      return 'empty'
    const notes = (await this.#readText(space, BRIEF_NOTES_PATH))?.content ?? ''
    const previous = await this.#readBrief(space)
    const hash = createHash('sha256')
      .update(JSON.stringify([PROMPT_VERSION, this.#d.model, material.fingerprint, notes]))
      .digest('hex')
    if (!opts.force && previous && previous.hash === hash) return 'unchanged'

    const member = await this.#d.members.get(principal.userId)
    const tz = member?.tz ?? 'UTC'
    const p = zonedParts(now, tz)
    const today = `${p.year}-${pad(p.month)}-${pad(p.day)}`
    const { system, user } = buildBriefPrompt({
      member: { name: principal.name, email: principal.email },
      org: this.#d.org,
      today,
      meetings: material.meetings,
      tasks: material.tasks,
      checkins: material.checkins,
      notes,
      previous: previous?.body ?? null,
    })
    const { text } = await this.#d.llm.complete({
      model: this.#d.model,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 8_000,
    })
    const body = cleanBrief(text)
    if (body === '') throw new HearthError('llm_error', 'The brief came back empty')
    const frontmatter = toYaml({
      type: 'agent-brief',
      generated: now.toISOString(),
      model: this.#d.model,
      meetings: material.meetings.length,
      tasks: material.tasks.length,
      window_days: BRIEF_WINDOW_DAYS,
      sources_hash: hash,
    })
    const content = `---\n${frontmatter}---\n# Agent brief: ${principal.name}\n\n${body}\n`
    await this.#commit(principal, space, BRIEF_PATH, content, 'write', opts.via)
    return 'written'
  }

  /** The member's recent meetings and tasks, cut to the budget, and a fingerprint of them. */
  async #material(
    principal: Principal,
    personal: string,
    now: Date,
  ): Promise<{
    meetings: BriefMeeting[]
    tasks: BriefTask[]
    checkins: BriefCheckin[]
    fingerprint: string[]
  }> {
    const since = now.getTime() - BRIEF_WINDOW_DAYS * 86_400_000
    const spaces = (await this.#d.spaces.visibleSpaces(principal)).map((s) => s.name)
    const rows = spaces
      .flatMap((space) =>
        this.#d.index
          .listFiles({ space, kind: 'meeting', order: 'date_desc' })
          .filter((f) => f.frontmatter?.type === 'meeting')
          // Their own meetings, and shared ones they were at.
          .filter(
            (f) =>
              space === personal ||
              (principal.email !== '' && matchesPerson(f.frontmatter, principal.email)),
          )
          .map((f) => ({ ...f, time: Date.parse(String(f.frontmatter?.date ?? '')) })),
      )
      .filter((f) => Number.isFinite(f.time) && f.time >= since && f.time <= now.getTime())
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_MEETINGS)

    const fingerprint: string[] = []
    const meetings: BriefMeeting[] = []
    let budget = MATERIAL_CHARS
    for (const row of rows) {
      const note = await this.#readText(row.space, row.path)
      if (!note) continue
      const fm = row.frontmatter ?? {}
      const transcriptPath = transcriptPathFor(row.path, fm)
      const transcript =
        // Only in their own space is "Me" the member: a shared note's "Me" is whoever took it.
        row.space === personal && transcriptPath
          ? await this.#readText(row.space, transcriptPath)
          : null
      const said = transcript
        ? parseTranscript(transcript.content)
            .filter((l) => l.speaker === 'Me')
            .map((l) => l.text)
            .join(' ')
        : ''
      const meeting: BriefMeeting = {
        space: row.space,
        path: row.path,
        title: row.title,
        date: String(fm.date ?? ''),
        attendees: strings(fm.attendees),
        note: cut(parseFrontmatter(note.content).body, NOTE_CHARS),
        said: cut(said, SAID_CHARS),
      }
      const size = meeting.note.length + meeting.said.length + 200
      if (size > budget) break
      budget -= size
      meetings.push(meeting)
      fingerprint.push(`${row.space}/${row.path}@${note.blobOid}:${transcript?.blobOid ?? ''}`)
    }

    const doneSince = new Date(now.getTime() - DONE_WINDOW_DAYS * 86_400_000).toISOString()
    const [open, done] = await Promise.all([
      this.#d.tasks.list(principal, { status: 'open', mine: true, limit: MAX_OPEN_TASKS }),
      this.#d.tasks.list(principal, { status: 'done', mine: true, doneSince, limit: 200 }),
    ])
    const recentDone = done
      .filter((t) => (t.completed ?? '') >= doneSince)
      .sort((a, b) => (b.completed ?? '').localeCompare(a.completed ?? ''))
      .slice(0, MAX_DONE_TASKS)
    const tasks = [...open, ...recentDone].map(toBriefTask)
    for (const t of [...open, ...recentDone]) fingerprint.push(`${t.space}/${t.id}@${t.blobOid}`)
    // Their own check-in answers of the window: what they said they'd do and what was stuck.
    const checkins = (
      this.#d.checkins?.answersSince(new Date(now.getTime() - BRIEF_WINDOW_DAYS * 86_400_000), {
        by: principal.email,
        limit: MAX_CHECKINS,
      }) ?? []
    ).map((a) => ({ question: a.question, date: a.date, text: a.text.slice(0, CHECKIN_CHARS) }))
    for (const a of checkins) fingerprint.push(`checkin ${a.date} ${a.question}:${a.text}`)
    return { meetings, tasks, checkins, fingerprint }
  }

  /** Refuses a forced rewrite past the member's limits (each is a large model call). */
  #allowForced(email: string): void {
    const now = this.#now().getTime()
    const recent = (this.#forced.get(email) ?? []).filter((t) => now - t < 86_400_000)
    const last = recent.at(-1)
    if (last !== undefined && now - last < this.#d.forcedGapMs) {
      throw new HearthError('rate_limited', 'Your brief was just rewritten. Try again in a minute.')
    }
    if (recent.length >= FORCED_PER_DAY) {
      throw new HearthError(
        'rate_limited',
        'Your brief has been rewritten a lot today. Try again tomorrow.',
      )
    }
    this.#forced.set(email, [...recent, now])
  }

  async #commit(
    principal: Principal,
    space: string,
    path: string,
    content: string,
    verb: string,
    via?: string,
  ): Promise<void> {
    const message = withVia(formatCommitMessage({ app: 'brief', verb, title: 'Agent brief' }), via)
    const result = await this.#d.git.commit(space, {
      changes: [{ path, content }],
      author: { name: principal.name, email: principal.email },
      message,
    })
    if (result.status === 'conflict') {
      throw new HearthError('conflict', 'Your agent brief changed while it was being saved')
    }
    await this.#d.syncer.afterHeadChanged(space)
  }

  async #personal(principal: Principal): Promise<string> {
    const own = (await this.#d.spaces.visibleSpaces(principal)).find((s) => s.kind === 'personal')
    if (!own) throw new HearthError('forbidden', 'Your personal space isn’t available')
    return own.name
  }

  async #readBrief(space: string): Promise<(AgentBrief & { hash: string | null }) | null> {
    const file = await this.#readText(space, BRIEF_PATH)
    if (!file) return null
    const { data, body } = parseFrontmatter(file.content)
    return {
      space,
      path: BRIEF_PATH,
      // The title line is Hearth's; agents and the page show the sections.
      body: body.replace(/^\s*# [^\n]*\n+/, '').trim(),
      generated: typeof data.generated === 'string' ? data.generated : '',
      model: typeof data.model === 'string' ? data.model : '',
      meetings: typeof data.meetings === 'number' ? data.meetings : 0,
      tasks: typeof data.tasks === 'number' ? data.tasks : 0,
      hash: typeof data.sources_hash === 'string' ? data.sources_hash : null,
    }
  }

  async #readText(
    space: string,
    path: string,
  ): Promise<{ content: string; blobOid: string } | null> {
    try {
      return await this.#d.git.readFile(space, path)
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
  }
}

/** Public view of a brief: without the internal fingerprint. */
export function publicBrief(brief: AgentBrief | null): AgentBrief | null {
  if (!brief) return null
  const { space, path, body, generated, model, meetings, tasks } = brief
  return { space, path, body, generated, model, meetings, tasks }
}

/**
 * Due once per night: the member's "brief day" starts at `hour` local time, and a member last
 * checked on an earlier brief day (or never) is due.
 */
export function isDue(checkedAt: string | null, now: Date, tz: string, hour: number): boolean {
  if (checkedAt === null) return true
  const checked = new Date(checkedAt)
  if (Number.isNaN(checked.getTime())) return true
  return briefDay(checked, tz, hour) < briefDay(now, tz, hour)
}

function briefDay(instant: Date, tz: string, hour: number): string {
  const p = zonedParts(new Date(instant.getTime() - hour * 3_600_000), safeZone(tz))
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function toBriefTask(t: TaskView): BriefTask {
  return {
    title: t.title,
    status: t.status,
    due: t.due,
    project: t.project,
    priority: t.priority,
    completed: t.completed,
  }
}

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return undefined
  }
}

function safeZone(tz: string): string {
  return validZone(tz) ?? 'UTC'
}

function cut(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
