// Booking links (ARCHITECTURE §19): a member's link files in their personal space, the public
// page's open slots, and booking one, which writes the event to the member's Google Calendar.

import { createHash, randomUUID } from 'node:crypto'
import {
  BOOKING_FOLDER,
  BookingFrontmatter,
  bookingPath,
  isBookingSlug,
  openSlots,
  parseFrontmatter,
  rulesOf,
  type Slot,
} from '@hearth/format'
import { stringify as toYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { RateLimiter } from '../dictation/rate-limit.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore } from '../git/index.js'
import type { SpaceRegistry, SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { BookingGoogle, Busy } from './google.js'
import type { RobotCheck } from './turnstile.js'

const MIN = 60_000
const DAY = 86_400_000
const MAX_RANGE_DAYS = 31
const BUSY_TTL_MS = 60_000
/** A just-made booking counts as busy this long, in case Google's freeBusy lags behind. */
const RECENT_MS = 10 * MIN
export const BOOKINGS_PER_IP_PER_HOUR = 5
export const BOOKINGS_PER_LINK_PER_DAY = 20
const PAGE_VIEWS_PER_IP_PER_HOUR = 600

export interface BookingLink {
  slug: string
  title: string
  minutes: number
  tz: string
  hours: BookingFrontmatter['hours']
  bufferBefore: number
  bufferAfter: number
  noticeMinutes: number
  horizonDays: number
  dailyCap: number | null
  questions: string[]
  description: string
  active: boolean
  blobOid: string
}

export type BookingInput = Omit<BookingLink, 'slug' | 'blobOid'> & { blobOid: string | null }

export interface BookingStatus {
  /** The member can make links: their Google grant can write events. */
  ready: boolean
  missing: 'scope' | null
  /** This server can take bookings (a robot check is set up). */
  canTakeBookings: boolean
  handle: string
  links: BookingLink[]
}

export interface PublicBookingPage {
  title: string
  minutes: number
  description: string
  ownerName: string
  questions: string[]
  slots: Slot[]
  robotCheck: RobotCheck['widget'] | null
  canTakeBookings: boolean
}

export interface BookingRequest {
  start: string
  name: string
  email: string
  answers: string[]
  token: string
  ip: string | null
}

export interface BookingDeps {
  git: Pick<GitStore, 'readFile' | 'listTree' | 'commit'>
  spaces: Pick<SpaceService, 'visibleSpaces'>
  registry: Pick<SpaceRegistry, 'getSpace'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  google: BookingGoogle
  /** A member by email, as the calendar last saw them signed in; null when it hasn't. */
  member: (email: string) => Principal | null
  /** The calendars the member syncs (empty: primary). */
  calendarsOf: (principal: Principal) => string[]
  /** Remember the member, so their public page can find them while they're signed out. */
  register: (principal: Principal) => void
  /** Null: this server can't take bookings (production without a Turnstile secret, S8). */
  robotCheck: RobotCheck | null
  now?: () => Date
  log?: (message: string) => void
}

interface Owner {
  principal: Principal
  space: string
}

export class Bookings {
  readonly #deps: BookingDeps
  readonly #now: () => Date
  readonly #log: (message: string) => void
  readonly #perIp = new RateLimiter(BOOKINGS_PER_IP_PER_HOUR, 60 * MIN)
  readonly #perLink = new RateLimiter(BOOKINGS_PER_LINK_PER_DAY, DAY)
  readonly #views = new RateLimiter(PAGE_VIEWS_PER_IP_PER_HOUR, 60 * MIN)
  readonly #busy = new Map<string, { at: number; busy: Busy[]; booked: string[] }>()
  readonly #recent = new Map<string, Array<Busy & { slug: string; at: number }>>()
  /** One booking at a time per member, so two bookers can't both take a slot. */
  readonly #locks = new Map<string, Promise<unknown>>()

  constructor(deps: BookingDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.warn
  }

  // ── the member's own links ───────────────────────────────────────────

  async status(principal: Principal): Promise<BookingStatus> {
    this.#deps.register(principal)
    const ready = await this.#deps.google.canWrite(principal).catch(() => false)
    const space = await this.#ownSpace(principal).catch(() => null)
    return {
      ready,
      missing: ready ? null : 'scope',
      canTakeBookings: this.#deps.robotCheck !== null,
      handle: space ?? principal.handle,
      links: space ? await this.#links(space) : [],
    }
  }

  async save(principal: Principal, slug: string, input: BookingInput): Promise<BookingLink> {
    if (!isBookingSlug(slug)) {
      throw new HearthError(
        'bad_request',
        'A link name is lowercase letters, numbers and dashes, up to 50',
      )
    }
    this.#deps.register(principal)
    if (!(await this.#deps.google.canWrite(principal))) {
      throw new HearthError(
        'forbidden',
        'Turn on booking links first: sign out and back in so events can be added to your calendar',
      )
    }
    const space = await this.#ownSpace(principal)
    const path = bookingPath(slug)
    const existing = await this.#read(space, path)
    const fm = BookingFrontmatter.safeParse({
      ...(existing?.data ?? {}),
      title: input.title,
      minutes: input.minutes,
      tz: input.tz,
      hours: input.hours,
      buffer_before: input.bufferBefore,
      buffer_after: input.bufferAfter,
      notice_minutes: input.noticeMinutes,
      horizon_days: input.horizonDays,
      daily_cap: input.dailyCap,
      questions: input.questions.map((q) => q.trim()).filter(Boolean),
      description: input.description.trim() || undefined,
      active: input.active,
    })
    if (!fm.success) {
      const issue = fm.error.issues[0]
      throw new HearthError(
        'bad_request',
        `${issue?.path.join('.') || 'link'}: ${issue?.message ?? 'invalid'}`,
      )
    }
    const data = Object.fromEntries(Object.entries(fm.data).filter(([, v]) => v !== undefined))
    const body = existing?.body ?? `\nA booking link. Change it in Meetings → Booking links.\n`
    const content = `---\n${toYaml(data)}---\n${body}`
    const result = await this.#deps.git.commit(space, {
      changes: [{ path, content }],
      author: { name: principal.name, email: principal.email },
      message: formatCommitMessage({
        app: 'booking',
        verb: existing ? 'edit' : 'create',
        title: fm.data.title.replace(/"/g, "'"),
      }),
      unchanged: { path, blobOid: input.blobOid },
    })
    await this.#deps.syncer.afterHeadChanged(space)
    if (result.status === 'conflict') {
      throw new HearthError(
        'conflict',
        input.blobOid === null
          ? `You already have a link named ${slug}`
          : 'This link was changed somewhere else meanwhile; reload it',
      )
    }
    return viewOf(slug, fm.data, result.blobOid)
  }

  async remove(principal: Principal, slug: string, blobOid: string): Promise<void> {
    if (!isBookingSlug(slug)) throw new HearthError('not_found', 'No such booking link')
    const space = await this.#ownSpace(principal)
    const path = bookingPath(slug)
    const existing = await this.#read(space, path)
    if (!existing) throw new HearthError('not_found', 'No such booking link')
    const title = typeof existing.data.title === 'string' ? existing.data.title : slug
    const result = await this.#deps.git.commit(space, {
      changes: [{ path, content: null }],
      author: { name: principal.name, email: principal.email },
      message: formatCommitMessage({
        app: 'booking',
        verb: 'delete',
        title: title.replace(/"/g, "'"),
      }),
      unchanged: { path, blobOid },
    })
    await this.#deps.syncer.afterHeadChanged(space)
    if (result.status === 'conflict') {
      throw new HearthError('conflict', 'This link was changed somewhere else meanwhile; reload it')
    }
  }

  // ── the public page ──────────────────────────────────────────────────

  async page(
    handle: string,
    slug: string,
    range: { from?: string | undefined; to?: string | undefined; ip: string | null },
  ): Promise<PublicBookingPage> {
    if (!this.#views.take(range.ip ?? 'unknown', this.#now().getTime())) {
      throw new HearthError('rate_limited', 'Too many requests; try again in a while')
    }
    const { owner, link } = await this.#publicLink(handle, slug)
    const now = this.#now()
    const from = parseInstant(range.from) ?? now.getTime()
    const to = parseInstant(range.to) ?? from + 7 * DAY
    if (!(to > from) || to - from > MAX_RANGE_DAYS * DAY) {
      throw new HearthError('bad_request', `Ask for up to ${MAX_RANGE_DAYS} days at a time`)
    }
    const fm = link.fm
    // Nothing can be booked outside notice..horizon, so Google isn't asked about it.
    const lo = Math.max(from, now.getTime() + fm.notice_minutes * MIN)
    const hi = Math.min(to, now.getTime() + fm.horizon_days * DAY)
    let slots: Slot[] = []
    if (lo < hi) {
      const { busy, booked } = await this.#calendar(owner.principal, slug, lo, hi, true)
      slots = openSlots(rulesOf(fm), busy, {
        now,
        from: new Date(lo).toISOString(),
        to: new Date(hi).toISOString(),
        booked,
      })
    }
    return {
      title: fm.title,
      minutes: fm.minutes,
      description: fm.description ?? '',
      ownerName: owner.principal.name,
      questions: fm.questions,
      slots,
      robotCheck: this.#deps.robotCheck?.widget ?? null,
      canTakeBookings: this.#deps.robotCheck !== null,
    }
  }

  async book(
    handle: string,
    slug: string,
    req: BookingRequest,
  ): Promise<{ start: string; end: string; meetLink: string | null }> {
    const robot = this.#deps.robotCheck
    if (!robot) {
      throw new HearthError('not_configured', "This booking page can't take bookings yet")
    }
    const { owner, link } = await this.#publicLink(handle, slug)
    const fm = link.fm
    const start = parseInstant(req.start)
    const name = req.name.replace(/\s+/g, ' ').trim()
    const email = req.email.trim().toLowerCase()
    if (start === null) throw new HearthError('bad_request', 'Pick a time')
    if (!name || name.length > 120) throw new HearthError('bad_request', 'Add your name')
    if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email) || email.length > 254) {
      throw new HearthError('bad_request', 'Add a valid email address')
    }
    if (req.answers.length > fm.questions.length || req.answers.some((a) => a.length > 2000)) {
      throw new HearthError('bad_request', 'Answers are up to 2,000 characters each')
    }
    const now = this.#now().getTime()
    if (!this.#perIp.take(req.ip ?? 'unknown', now)) {
      throw new HearthError('rate_limited', 'Too many bookings from here; try again in an hour')
    }
    const linkKey = `${handle}/${slug}`
    if (!this.#perLink.allows(linkKey, now)) {
      throw new HearthError('rate_limited', 'This link has had too many bookings today')
    }
    if (!(await robot.verify(req.token, req.ip))) {
      throw new HearthError('forbidden', "Couldn't confirm you're a person; try the check again")
    }
    if (email === owner.principal.email.toLowerCase()) {
      throw new HearthError('bad_request', 'That’s the address of the person you’re booking with')
    }

    const end = start + fm.minutes * MIN
    return this.#serially(owner.principal.email, async () => {
      // Rechecked against Google live, not the page's copy (S4).
      const { busy, booked } = await this.#calendar(owner.principal, slug, start, end, false)
      const open = openSlots(rulesOf(fm), busy, {
        now: this.#now(),
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        booked,
      })
      if (!open.some((s) => Date.parse(s.start) === start)) {
        throw new HearthError('conflict', 'That time was just taken. Pick another one.')
      }
      const startIso = new Date(start).toISOString()
      const endIso = new Date(end).toISOString()
      if (!this.#perLink.take(linkKey, now)) {
        throw new HearthError('rate_limited', 'This link has had too many bookings today')
      }
      let event: { id: string; meetLink: string | null }
      try {
        event = await this.#deps.google.insert(owner.principal, {
          // The same booker, link and time is the same event, so a retry after a timeout
          // can't book it twice (Google answers 409).
          id: eventId(owner.principal.email, slug, start, email),
          slug,
          title: `${fm.title}: ${name}`,
          start: startIso,
          end: endIso,
          description: describe(fm.title, name, email, fm.questions, req.answers),
          booker: { name, email },
          requestId: randomUUID(),
        })
      } catch (err) {
        this.#log(`booking ${handle}/${slug} at ${startIso}: ${err}`)
        if (err instanceof HearthError && err.code === 'conflict') {
          throw new HearthError(
            'conflict',
            'That time was just taken. If you booked it, the invite is on its way to your email.',
          )
        }
        throw new HearthError('host_error', "Couldn't add the meeting to the calendar. Try again.")
      }
      const key = owner.principal.email.toLowerCase()
      const recent = (this.#recent.get(key) ?? []).filter((r) => r.at > now - RECENT_MS)
      recent.push({ start: startIso, end: endIso, slug, at: now })
      this.#recent.set(key, recent)
      for (const k of this.#busy.keys()) if (k.startsWith(`${key}|`)) this.#busy.delete(k)
      return { start: startIso, end: endIso, meetLink: event.meetLink }
    })
  }

  // ── helpers ──────────────────────────────────────────────────────────

  async #ownSpace(principal: Principal): Promise<string> {
    const own = (await this.#deps.spaces.visibleSpaces(principal)).find(
      (s) => s.kind === 'personal',
    )
    if (!own) {
      throw new HearthError('forbidden', "Your personal space isn't ready yet; try again shortly")
    }
    return own.name
  }

  async #links(space: string): Promise<BookingLink[]> {
    const entries = await this.#deps.git.listTree(space, BOOKING_FOLDER).catch(() => [])
    const links: BookingLink[] = []
    for (const entry of entries) {
      const slug = entry.path.split('/').pop()?.replace(/\.md$/, '') ?? ''
      if (entry.type !== 'file' || !entry.path.endsWith('.md') || !isBookingSlug(slug)) continue
      const file = await this.#read(space, bookingPath(slug))
      const fm = file && BookingFrontmatter.safeParse(file.data)
      if (file && fm?.success) links.push(viewOf(slug, fm.data, file.blobOid))
    }
    return links.sort((a, b) => a.title.localeCompare(b.title))
  }

  async #read(
    space: string,
    path: string,
  ): Promise<{ data: Record<string, unknown>; body: string; blobOid: string } | null> {
    try {
      const { content, blobOid } = await this.#deps.git.readFile(space, path)
      const parsed = parseFrontmatter(content)
      return { data: parsed.data, body: parsed.body, blobOid }
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
  }

  async #publicLink(
    handle: string,
    slug: string,
  ): Promise<{ owner: Owner; link: { fm: BookingFrontmatter } }> {
    const missing = new HearthError('not_found', 'This booking link does not exist')
    if (!isBookingSlug(slug) || !/^[a-z0-9-]{1,100}$/.test(handle)) throw missing
    const record = this.#deps.registry.getSpace(handle)
    if (record?.kind !== 'personal' || !record.ownerEmail) throw missing
    let file: { data: Record<string, unknown>; body: string; blobOid: string } | null = null
    try {
      file = await this.#read(handle, bookingPath(slug))
    } catch (err) {
      this.#log(`booking link ${handle}/${slug}: ${err}`)
      throw missing
    }
    const fm = file && BookingFrontmatter.safeParse(file.data)
    if (!fm?.success || !fm.data.active) throw missing
    const principal = this.#deps.member(record.ownerEmail)
    if (!principal) {
      this.#log(`booking link ${handle}/${slug}: ${record.ownerEmail} isn't a registered member`)
      throw missing
    }
    return { owner: { principal, space: handle }, link: { fm: fm.data } }
  }

  /** Busy times (plus this server's recent bookings) and this link's bookings in from..to. */
  async #calendar(
    principal: Principal,
    slug: string,
    from: number,
    to: number,
    cached: boolean,
  ): Promise<{ busy: Busy[]; booked: string[] }> {
    const owner = principal.email.toLowerCase()
    // Asked of Google in whole UTC days with a day either side: every local day the range
    // touches is complete (for the daily cap), and nearby page views share one cache entry.
    from = Math.floor(from / DAY) * DAY - DAY
    to = Math.ceil(to / DAY) * DAY + DAY
    const key = `${owner}|${slug}|${from}|${to}`
    const now = this.#now().getTime()
    const hit = this.#busy.get(key)
    let fresh = cached && hit && now - hit.at < BUSY_TTL_MS ? hit : null
    if (!fresh) {
      const fromIso = new Date(from).toISOString()
      const toIso = new Date(to).toISOString()
      try {
        const [busy, booked] = await Promise.all([
          this.#deps.google.busy(principal, this.#deps.calendarsOf(principal), fromIso, toIso),
          this.#deps.google.booked(principal, slug, fromIso, toIso),
        ])
        fresh = { at: now, busy, booked }
      } catch (err) {
        this.#log(`booking calendar for ${owner}: ${err}`)
        throw new HearthError('not_configured', "This booking page isn't available right now")
      }
      if (this.#busy.size > 500) this.#busy.clear()
      this.#busy.set(key, fresh)
    }
    const recent = (this.#recent.get(owner) ?? []).filter((r) => r.at > now - RECENT_MS)
    const booked = new Set(fresh.booked.map((b) => Date.parse(b)))
    return {
      busy: [...fresh.busy, ...recent.map((r) => ({ start: r.start, end: r.end }))],
      booked: [
        ...fresh.booked,
        ...recent
          .filter((r) => r.slug === slug && !booked.has(Date.parse(r.start)))
          .map((r) => r.start),
      ],
    }
  }

  async #serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve()
    const run = before.then(fn, fn)
    const settled = run.catch(() => {})
    this.#locks.set(key, settled)
    try {
      return await run
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key)
    }
  }
}

/** A Google event id (base32hex; lowercase hex is a subset) fixed by owner, link, start and booker. */
function eventId(owner: string, slug: string, start: number, booker: string): string {
  const key = `${owner.toLowerCase()}|${slug}|${start}|${booker}`
  return `hb${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
}

function parseInstant(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function viewOf(slug: string, fm: BookingFrontmatter, blobOid: string): BookingLink {
  return {
    slug,
    title: fm.title,
    minutes: fm.minutes,
    tz: fm.tz,
    hours: fm.hours,
    bufferBefore: fm.buffer_before,
    bufferAfter: fm.buffer_after,
    noticeMinutes: fm.notice_minutes,
    horizonDays: fm.horizon_days,
    dailyCap: fm.daily_cap,
    questions: fm.questions,
    description: fm.description ?? '',
    active: fm.active,
    blobOid,
  }
}

/** The event description: who booked and their answers; it becomes the meeting's context. */
function describe(
  title: string,
  name: string,
  email: string,
  questions: string[],
  answers: string[],
): string {
  const lines = [`Booked through the booking link "${title}".`, '', `Name: ${name}`]
  lines.push(`Email: ${email}`)
  questions.forEach((q, i) => {
    const a = answers[i]?.trim()
    if (a) lines.push('', q, a)
  })
  return lines.join('\n')
}
