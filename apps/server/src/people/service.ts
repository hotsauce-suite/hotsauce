// People (ARCHITECTURE §17): a light CRM nobody types into. A person is an email seen in the
// attendees of a meeting note or a calendar event, or a task's assignee; a company is an email
// domain. Everything is worked out per request from the index, the calendar cache and the task
// list, and only from what the member can read, so someone who appears only in a teammate's
// personal notes doesn't exist for them. The one thing written down is a person's About note, a
// team file `people/<email>.md`.

import { stringify as toYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import type { Index } from '../index/index.js'
import type { CalendarSource } from '../meetings/calendar/types.js'
import { attendeeEmail, strings } from '../meetings/list.js'
import type { Space, SpaceService } from '../spaces/index.js'
import { TEAM_SPACE } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { Tasks, TaskView } from '../tasks/index.js'

const DAY_MS = 86_400_000
/** How far ahead the calendar is read for a person's next meeting. */
const NEXT_DAYS = 60
/** The longest About note, in characters. */
export const MAX_ABOUT = 20_000
/** Most people a list returns. */
export const MAX_PEOPLE = 1000
const MAX_HISTORY = 200

/** Mail providers whose domain says nothing about where someone works. */
export const PERSONAL_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'googlemail.com',
  'hey.com',
  'hotmail.com',
  'hotmail.co.uk',
  'icloud.com',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'qq.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yandex.com',
  'zoho.com',
])

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

export interface MeetingRef {
  space: string
  path: string
  title: string
  date: string
}

export interface PersonSummary {
  email: string
  /** From calendar display names or a note's `Name <email>`; null when nobody named them. */
  name: string | null
  /** The email's domain, or null for personal mail (gmail.com and similar). */
  company: string | null
  /** One of the organization's own domains, or a member. */
  team: boolean
  /** Meeting notes they attended that the member can read. */
  meetings: number
  last: MeetingRef | null
  /** Their next event on the member's calendar. */
  next: { title: string; start: string } | null
}

export interface PersonView extends PersonSummary {
  /** Readable meeting notes they attended, newest first. */
  history: MeetingRef[]
  /** Open tasks assigned to them. */
  tasks: TaskView[]
  /** The team's About note; blobOid is null until someone writes one. */
  about: { text: string; blobOid: string | null }
  /**
   * Whether the member may write About: only for someone the whole team can already see (a team
   * meeting, a team task, a member), since the note is a team file.
   */
  canEditAbout: boolean
}

export interface CompanyView {
  domain: string
  team: boolean
  people: PersonSummary[]
  meetings: MeetingRef[]
}

export interface PeopleDeps {
  index: Pick<Index, 'listFiles' | 'bodyAt'>
  spaces: Pick<SpaceService, 'visibleSpaces' | 'canAccess'>
  tasks: Pick<Tasks, 'list' | 'people'>
  calendar: CalendarSource
  git: Pick<GitStore, 'commit'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  /** The organization's email domains (`ALLOWED_EMAIL_DOMAINS`). */
  internalDomains: readonly string[]
  now?: () => Date
}

interface Acc {
  email: string
  calendarName: string | null
  noteName: string | null
  memberName: string | null
  /** Seen somewhere the whole team can read: a team meeting note, a team task, or a member. */
  teamVisible: boolean
  history: MeetingRef[]
  next: { title: string; start: string } | null
}

interface Gathered {
  spaces: Space[]
  byEmail: Map<string, Acc>
  members: Set<string>
  openTasks: TaskView[]
}

/** A person's About file in the team space. */
export function aboutPath(email: string): string {
  return `people/${email}.md`
}

/** The email lowercased, or bad_request when it isn't one. */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase()
  if (!EMAIL.test(e) || e.length > 254 || e.includes('/')) {
    throw new HearthError('bad_request', `"${email}" isn't an email address`)
  }
  return e
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}

/** `Name <email>` → Name; a bare email has none. */
function labelName(attendee: string): string | null {
  const m = /^\s*(.*?)\s*<[^<>]*>\s*$/.exec(attendee)
  const name = m?.[1]?.replace(/^"|"$/g, '').trim()
  return name ? name : null
}

function byNewest(a: MeetingRef, b: MeetingRef): number {
  return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.path.localeCompare(b.path)
}

export class People {
  readonly #deps: PeopleDeps
  readonly #now: () => Date
  readonly #ours: Set<string>

  constructor(deps: PeopleDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
    this.#ours = new Set(deps.internalDomains.map((d) => d.toLowerCase()))
  }

  /** Everyone the member can see, most recent meeting first; `q` matches name, email or company. */
  async list(
    principal: Principal,
    opts: { q?: string | undefined } = {},
  ): Promise<PersonSummary[]> {
    const g = await this.#gather(principal)
    const q = opts.q?.trim().toLowerCase()
    return [...g.byEmail.values()]
      .map((a) => this.#summary(a, g))
      .filter(
        (p) =>
          !q ||
          p.email.includes(q) ||
          (p.name?.toLowerCase().includes(q) ?? false) ||
          (p.company?.includes(q) ?? false),
      )
      .sort(
        (a, b) =>
          (b.last ? Date.parse(b.last.date) || 0 : -1) -
            (a.last ? Date.parse(a.last.date) || 0 : -1) ||
          b.meetings - a.meetings ||
          a.email.localeCompare(b.email),
      )
      .slice(0, MAX_PEOPLE)
  }

  async get(principal: Principal, email: string): Promise<PersonView> {
    const e = normalizeEmail(email)
    const g = await this.#gather(principal)
    const acc = g.byEmail.get(e)
    if (!acc) throw new HearthError('not_found', `No one called ${e} in what you can read`)
    return {
      ...this.#summary(acc, g),
      history: acc.history.slice(0, MAX_HISTORY),
      tasks: g.openTasks.filter((t) => t.assignee === e),
      about: this.#about(e, g.spaces),
      canEditAbout: acc.teamVisible,
    }
  }

  async company(principal: Principal, domain: string): Promise<CompanyView> {
    const d = domain.trim().toLowerCase()
    const g = await this.#gather(principal)
    const accs = [...g.byEmail.values()].filter((a) => domainOf(a.email) === d)
    const people = accs.map((a) => this.#summary(a, g)).filter((p) => p.company === d)
    if (people.length === 0)
      throw new HearthError('not_found', `No company ${d} in what you can read`)
    const seen = new Set<string>()
    const meetings: MeetingRef[] = []
    for (const a of accs) {
      for (const m of a.history) {
        const key = `${m.space}\n${m.path}`
        if (!seen.has(key)) {
          seen.add(key)
          meetings.push(m)
        }
      }
    }
    return {
      domain: d,
      team: this.#ours.has(d),
      people: people.sort((a, b) => b.meetings - a.meetings || a.email.localeCompare(b.email)),
      meetings: meetings.sort(byNewest).slice(0, MAX_HISTORY),
    }
  }

  /**
   * Writes the About note, `blobOid` being the version the member edited (null: there was none).
   * Refuses (conflict) if it changed meanwhile, and (not_found) for anyone they can't see.
   */
  async saveAbout(
    principal: Principal,
    email: string,
    input: { text: string; blobOid: string | null },
    via?: string,
  ): Promise<{ blobOid: string }> {
    const e = normalizeEmail(email)
    if (!this.#deps.spaces.canAccess(principal, TEAM_SPACE)) {
      throw new HearthError('forbidden', `You don't have access to the space "${TEAM_SPACE}"`)
    }
    const g = await this.#gather(principal)
    const acc = g.byEmail.get(e)
    if (!acc) throw new HearthError('not_found', `No one called ${e} in what you can read`)
    // A team file about someone only you can see would tell the team they exist.
    if (!acc.teamVisible) {
      throw new HearthError(
        'forbidden',
        `${e} is only in your own meetings, so they can't have a team note yet`,
      )
    }
    const path = aboutPath(e)
    const text = input.text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
    const fm = toYaml({
      email: e,
      updated: this.#now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
      updated_by: principal.email.toLowerCase(),
    })
    const content = `---\n${fm}---\n\n${text}\n`
    const summary = this.#summary(acc, g)
    const message = withVia(
      formatCommitMessage({
        app: 'people',
        verb: 'edit',
        title: (summary.name ?? e).replace(/"/g, "'"),
      }),
      via,
    )
    const result = await this.#deps.git.commit(TEAM_SPACE, {
      changes: [{ path, content }],
      author: { name: principal.name, email: principal.email },
      message,
      // Null: create only, checked under the space lock, so two first saves can't both land.
      unchanged: { path, blobOid: input.blobOid },
    })
    await this.#deps.syncer.afterHeadChanged(TEAM_SPACE)
    if (result.status === 'conflict') {
      throw new HearthError('conflict', `Someone changed the About for ${e} meanwhile`)
    }
    return { blobOid: result.blobOid }
  }

  #about(email: string, spaces: Space[]): PersonView['about'] {
    if (!spaces.some((s) => s.name === TEAM_SPACE)) return { text: '', blobOid: null }
    const path = aboutPath(email)
    const row = this.#deps.index
      .listFiles({ space: TEAM_SPACE, kind: 'person', prefix: path })
      .find((f) => f.path === path)
    if (!row) return { text: '', blobOid: null }
    const body = this.#deps.index.bodyAt(TEAM_SPACE, path)?.body ?? ''
    return { text: body.replace(/^\s*\n/, '').replace(/\s+$/, ''), blobOid: row.blobOid }
  }

  #summary(a: Acc, g: Gathered): PersonSummary {
    const domain = domainOf(a.email)
    const team = this.#ours.has(domain) || g.members.has(a.email)
    return {
      email: a.email,
      name: a.calendarName ?? a.noteName ?? a.memberName,
      company: PERSONAL_MAIL_DOMAINS.has(domain) ? null : domain,
      team,
      meetings: a.history.length,
      last: a.history[0] ?? null,
      next: a.next,
    }
  }

  async #gather(principal: Principal): Promise<Gathered> {
    const { index, tasks, calendar } = this.#deps
    const me = principal.email.toLowerCase()
    const spaces = await this.#deps.spaces.visibleSpaces(principal)
    const byEmail = new Map<string, Acc>()
    const acc = (email: string): Acc | null => {
      const e = email.trim().toLowerCase()
      if (e === me || !EMAIL.test(e)) return null
      let a = byEmail.get(e)
      if (!a) {
        a = {
          email: e,
          calendarName: null,
          noteName: null,
          memberName: null,
          teamVisible: false,
          history: [],
          next: null,
        }
        byEmail.set(e, a)
      }
      return a
    }

    for (const s of spaces) {
      for (const file of index.listFiles({ space: s.name, kind: 'meeting' })) {
        const fm = file.frontmatter
        if (fm?.type !== 'meeting') continue
        const ref: MeetingRef = {
          space: s.name,
          path: file.path,
          title: file.title,
          date: typeof fm.date === 'string' ? fm.date : '',
        }
        const seen = new Set<string>()
        for (const attendee of strings(fm.attendees)) {
          const a = acc(attendeeEmail(attendee))
          if (!a || seen.has(a.email)) continue
          seen.add(a.email)
          a.history.push(ref)
          if (s.kind === 'team') a.teamVisible = true
          a.noteName ??= labelName(attendee)
        }
      }
    }
    for (const a of byEmail.values()) a.history.sort(byNewest)

    const now = this.#now().getTime()
    try {
      const events = await calendar.upcoming(principal, {
        from: new Date(now).toISOString(),
        to: new Date(now + NEXT_DAYS * DAY_MS).toISOString(),
      })
      for (const ev of [...events].sort((x, y) => x.start.localeCompare(y.start))) {
        for (const att of ev.attendees) {
          const a = acc(att.email)
          if (!a) continue
          if (att.name?.trim()) a.calendarName ??= att.name.trim()
          if (!a.next && Date.parse(ev.start) >= now) a.next = { title: ev.title, start: ev.start }
        }
      }
    } catch {
      // No calendar (no grant, Google down): people still come from notes and tasks.
    }

    const openTasks = await tasks.list(principal, { status: 'open' }, { spaces })
    for (const t of openTasks) {
      const a = t.assignee ? acc(t.assignee) : null
      if (a && t.space === TEAM_SPACE) a.teamVisible = true
    }

    const members = new Set<string>()
    for (const m of tasks.people(principal)) {
      members.add(m.email)
      const a = byEmail.get(m.email)
      if (a) {
        a.memberName = m.name
        a.teamVisible = true
      }
    }
    return { spaces, byEmail, members, openTasks }
  }
}
