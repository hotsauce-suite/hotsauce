import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { parseFrontmatter } from '@hearth/format'
import { stringify as toYaml } from 'yaml'
import type { Authenticator, Principal } from '../auth/index.js'
import { type BriefMembers, isDue } from '../brief/index.js'
import type { Checkins } from '../checkins/index.js'
import { HearthError } from '../errors.js'
import { formatCommitMessage, type GitStore, withVia } from '../git/index.js'
import { KeyedMutex } from '../git/mutex.js'
import { extractDoc, type Index, kindOf } from '../index/index.js'
import type { Links, LinkView } from '../links/index.js'
import type { AudioStore } from '../meetings/audio/types.js'
import type { CalendarSource } from '../meetings/calendar/types.js'
import { matchesPerson } from '../meetings/list.js'
import type { LLM } from '../meetings/llm/types.js'
import type { PushSender } from '../meetings/reminders/sender.js'
import type { ReminderStore } from '../meetings/reminders/store.js'
import { clockTimeIn, zonedParts } from '../meetings/zoned-time.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { Tasks } from '../tasks/index.js'
import {
  buildBriefcastPrompt,
  type CastCheckin,
  type CastDoc,
  type CastEvent,
  type CastLink,
  type CastMeeting,
  type CastTask,
  cleanScript,
} from './prompt.js'
import { mp3Seconds, type Speaker } from './speaker.js'
import type { BriefcastState } from './store.js'

/** Each episode's script, in the member's personal space; one file per day. */
export const EPISODE_DIR = '.hearth/briefcast'
/** Audio is kept this many days, then deleted; the script stays. */
export const AUDIO_DAYS = 30
const PREP_WINDOW_DAYS = 30
const MAX_EVENTS = 12
const MAX_RECENT_MEETINGS = 8
const RECENT_NOTE_CHARS = 3_000
const PREP_NOTE_CHARS = 800
const MAX_DOCS = 12
/** Commits read per space to find the window's base, and changed files looked into. */
const LOG_DEPTH = 2_000
const MAX_DOC_LOOKUPS = 40
const DOC_CHARS = 600
const MAX_TASKS = 40
const TICK_MS = 15 * 60_000
const PROMPT_VERSION = 2
/** Saved links read out in one briefing, and last week's unread ones on Mondays. */
const MAX_LINKS = 8
/** Teammates' check-in answers read in one briefing, each cut to this many characters. */
const MAX_CHECKINS = 12
const CHECKIN_CHARS = 600
const MAX_UNREAD_LINKS = 5
const NIGHTLY_ATTEMPTS = 3
const FORCED_PER_DAY = 10

export interface EpisodeSummary {
  date: string
  title: string
  generated: string
  /** Seconds of audio, when known. */
  seconds: number | null
  /** Audio exists (it may since have been deleted after 30 days). */
  audio: boolean
}

export interface Episode extends EpisodeSummary {
  script: string
  /** It had audio, deleted after 30 days. */
  audioExpired: boolean
  model: string
  voice: string
  counts: {
    events: number
    meetings: number
    tasks: number
    docs: number
    links: number
    checkins: number
  }
}

export interface BriefcastOverview {
  episodes: EpisodeSummary[]
  latest: Episode | null
  /** The member's private podcast feed URL, once they've made one. */
  feedUrl: string | null
  /** False when no voice is configured: episodes are scripts only. */
  voice: boolean
  /** Local hour by which each weekday's episode is ready. */
  readyHour: number
}

export type CastStatus = 'written' | 'unchanged' | 'empty'

type Deps = {
  git: Pick<GitStore, 'readFile' | 'commit' | 'listTree' | 'log' | 'changedPaths' | 'headOid'>
  index: Pick<Index, 'listFiles'>
  spaces: Pick<SpaceService, 'visibleSpaces' | 'ensurePersonalSpace'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  tasks: Pick<Tasks, 'list'>
  /** Saved links (§23); null leaves them out. */
  links: Pick<Links, 'list'> | null
  /** Check-in answers (§24); null leaves them out. */
  checkins?: Pick<Checkins, 'answersSince'> | null
  calendar: CalendarSource
  llm: LLM
  model: string
  speaker: Speaker
  audio: AudioStore | null
  members: BriefMembers
  state: BriefcastState
  auth: Pick<Authenticator, 'principalForUser'>
  push: { store: Pick<ReminderStore, 'subscribers' | 'unsubscribe'>; sender: PushSender } | null
  org: string
  /** The public origin, for feed URLs. */
  publicUrl: string
  /** Local hour (0–23) by which the morning episode should be ready; writing starts an hour before. */
  hour: number
  forcedGapMs: number
  nightly: boolean
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Briefcast (plan `docs/plans/2026-11-12-briefcast.md`): a short spoken briefing each weekday
 * morning, written by the language model from the member's calendar, recent meetings, tasks and
 * changed docs, read aloud by a text-to-speech voice, and offered on a page and a private podcast
 * feed.
 */
export class Briefcasts {
  readonly #d: Deps
  readonly #now: () => Date
  readonly #log: (message: string) => void
  readonly #lock = new KeyedMutex()
  readonly #failures = new Map<string, number>()
  readonly #forced = new Map<string, number[]>()
  #timer: ReturnType<typeof setInterval> | null = null
  #catchUp: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #stopping = false

  constructor(deps: Deps) {
    this.#d = deps
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.error
  }

  async touch(principal: Principal, tz?: string): Promise<void> {
    if (principal.userId === '') return
    await this.#d.members.touch(principal.userId, principal.email, validZone(tz))
  }

  async overview(principal: Principal): Promise<BriefcastOverview> {
    const space = await this.#personal(principal)
    const episodes = await this.#list(space)
    const newest = episodes[0]
    const token = await this.#d.state.feedToken(principal.userId)
    return {
      episodes,
      latest: newest ? await this.#read(space, newest.date) : null,
      feedUrl: token ? this.#feedUrl(token) : null,
      voice: this.#voiced(),
      readyHour: this.#d.hour,
    }
  }

  async episode(principal: Principal, date: string): Promise<Episode> {
    const episode = await this.#read(await this.#personal(principal), assertDate(date))
    if (!episode) throw new HearthError('not_found', 'No Briefcast for that day')
    return episode
  }

  /** The episode's MP3, or not_found once it is gone (deleted after 30 days, or never made). */
  async audio(principal: Principal, date: string): Promise<Uint8Array> {
    return this.#audioFor(principal.userId, assertDate(date))
  }

  // ── writing ──────────────────────────────────────────────────────────────

  /** Writes today's episode. Unless `force`, nothing is written when the material is unchanged. */
  async refresh(
    principal: Principal,
    opts: { force?: boolean; via?: string } = {},
  ): Promise<{ status: CastStatus; episode: Episode | null }> {
    if (opts.force) this.#allowForced(principal.email)
    return this.#lock.run(principal.email, async () => {
      const space = await this.#personal(principal)
      const { status, date } = await this.#write(principal, space, opts)
      return { status, episode: date ? await this.#read(space, date) : null }
    })
  }

  async #write(
    principal: Principal,
    space: string,
    opts: { force?: boolean; via?: string },
  ): Promise<{ status: CastStatus; date: string | null }> {
    const now = this.#now()
    const tz = (await this.#d.members.get(principal.userId))?.tz ?? 'UTC'
    const day = localDay(now, tz)
    const material = await this.#material(principal, space, now, tz, day.weekday)
    const counts = {
      events: material.events.length,
      meetings: material.meetings.length,
      tasks: material.tasks.length,
      docs: material.docs.length,
      links: material.links.length,
      checkins: material.checkins.length,
    }
    if (Object.values(counts).every((n) => n === 0)) {
      return { status: 'empty', date: null }
    }
    const { system, user } = buildBriefcastPrompt({
      member: { name: principal.name, email: principal.email },
      org: this.#d.org,
      dayLabel: day.label,
      today: day.date,
      sinceLabel: day.weekday === 'Mon' ? 'since Friday morning' : 'in the last day',
      ...material,
    })
    const hash = createHash('sha256')
      .update(JSON.stringify([PROMPT_VERSION, this.#d.model, this.#d.speaker.voice, user]))
      .digest('hex')
    const previous = await this.#readFile(space, episodePath(day.date))
    if (!opts.force && previous && parseFrontmatter(previous).data.sources_hash === hash) {
      return { status: 'unchanged', date: day.date }
    }

    const { text } = await this.#d.llm.complete({
      model: this.#d.model,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 3_000,
    })
    const script = cleanScript(text)
    if (script === '') throw new HearthError('llm_error', 'The Briefcast script came back empty')

    // Audio first, so a script in Git means its audio was stored (when there is a voice).
    let seconds: number | null = null
    let bytes = 0
    if (this.#voiced() && this.#d.audio) {
      try {
        const mp3 = await this.#d.speaker.speak(script)
        const key = audioKey(principal.userId, day.date)
        await this.#d.audio.put(key, Readable.from(Buffer.from(mp3)), mp3.length, 'audio/mpeg')
        await this.#d.state.recordAudio(key, principal.userId, day.date)
        seconds = mp3Seconds(mp3)
        bytes = mp3.length
      } catch (err) {
        // The script is still worth having; "Make today's briefing" tries the voice again.
        this.#log(`briefcast: voice failed for ${principal.email}: ${errorText(err)}`)
      }
    }
    const frontmatter = toYaml({
      type: 'briefcast',
      date: day.date,
      generated: now.toISOString(),
      model: this.#d.model,
      voice: bytes > 0 ? this.#d.speaker.voice : '',
      seconds,
      audio_bytes: bytes,
      ...counts,
      sources_hash: hash,
    })
    const content = `---\n${frontmatter}---\n# ${titleFor(day.label)}\n\n${script}\n`
    await this.#commit(principal, space, episodePath(day.date), content, opts.via)
    return { status: 'written', date: day.date }
  }

  async #material(
    principal: Principal,
    personal: string,
    now: Date,
    tz: string,
    weekday: string,
  ): Promise<{
    events: CastEvent[]
    meetings: CastMeeting[]
    tasks: CastTask[]
    docs: CastDoc[]
    links: CastLink[]
    checkins: CastCheckin[]
  }> {
    const since = new Date(now.getTime() - (weekday === 'Mon' ? 72 : 24) * 3_600_000)
    const spaces = await this.#d.spaces.visibleSpaces(principal)

    // Meetings of the last 30 days the member took or attended, newest first.
    const prepSince = now.getTime() - PREP_WINDOW_DAYS * 86_400_000
    const rows = spaces
      .flatMap((s) =>
        this.#d.index
          .listFiles({ space: s.name, kind: 'meeting', order: 'date_desc' })
          .filter((f) => f.frontmatter?.type === 'meeting')
          .filter(
            (f) =>
              s.name === personal ||
              (principal.email !== '' && matchesPerson(f.frontmatter, principal.email)),
          )
          .map((f) => ({ ...f, time: Date.parse(String(f.frontmatter?.date ?? '')) })),
      )
      .filter((f) => Number.isFinite(f.time) && f.time >= prepSince && f.time <= now.getTime())
      .sort((a, b) => b.time - a.time)

    const meetings: CastMeeting[] = []
    for (const row of rows.filter((r) => r.time >= since.getTime())) {
      if (meetings.length >= MAX_RECENT_MEETINGS) break
      const note = await this.#readFile(row.space, row.path)
      if (note === null) continue
      meetings.push({
        title: row.title,
        date: String(row.frontmatter?.date ?? ''),
        attendees: strings(row.frontmatter?.attendees),
        note: cut(parseFrontmatter(note).body, RECENT_NOTE_CHARS),
      })
    }

    // Today's calendar, from now to the end of the member's day, with prep from earlier meetings.
    const p = zonedParts(now, tz)
    const end = new Date(now.getTime() + ((24 - p.hour) * 60 - p.minute) * 60_000)
    let upcoming: Awaited<ReturnType<CalendarSource['upcoming']>> = []
    try {
      upcoming = await this.#d.calendar.upcoming(principal, {
        from: now.toISOString(),
        to: end.toISOString(),
      })
    } catch (err) {
      // No Google connection is normal; the briefing goes on without the calendar.
      this.#log(`briefcast: calendar unavailable for ${principal.email}: ${errorText(err)}`)
    }
    const me = principal.email.toLowerCase()
    const events: CastEvent[] = []
    for (const e of upcoming.slice(0, MAX_EVENTS)) {
      const others = e.attendees.filter((a) => a.email !== '' && a.email.toLowerCase() !== me)
      const prep: CastEvent['prep'] = []
      for (const row of rows) {
        if (prep.length >= 2) break
        if (!others.some((a) => matchesPerson(row.frontmatter, a.email))) continue
        const note = await this.#readFile(row.space, row.path)
        if (note === null) continue
        prep.push({
          title: row.title,
          date: String(row.frontmatter?.date ?? ''),
          note: cut(parseFrontmatter(note).body, PREP_NOTE_CHARS),
        })
      }
      events.push({
        title: e.title,
        time: clockTimeIn(new Date(e.start), tz),
        attendees: others.map((a) => a.name || a.email),
        prep,
      })
    }

    // Tasks: open ones due today or earlier, and ones finished since yesterday.
    const today = localDay(now, tz).date
    const [due, done] = await Promise.all([
      this.#d.tasks.list(principal, { status: 'open', mine: true, dueBefore: today, limit: 100 }),
      this.#d.tasks.list(principal, {
        status: 'done',
        mine: true,
        doneSince: since.toISOString(),
        limit: 50,
      }),
    ])
    const tasks: CastTask[] = [
      ...due.sort((a, b) => a.priority - b.priority || (a.due ?? '').localeCompare(b.due ?? '')),
      ...done.filter((t) => (t.completed ?? '') >= since.toISOString()),
    ]
      .slice(0, MAX_TASKS)
      .map((t) => ({
        title: t.title,
        status: t.status,
        due: t.due,
        project: t.project,
        priority: t.priority,
        completed: t.completed,
      }))

    const docs = await this.#changedDocs(principal, spaces, since)
    const links = await this.#savedLinks(principal, since, weekday === 'Mon')
    // Teammates' check-in answers since the last briefing; the listener's own add nothing.
    const checkins = (this.#d.checkins?.answersSince(since, { limit: MAX_CHECKINS * 2 }) ?? [])
      .filter((a) => a.email.toLowerCase() !== principal.email.toLowerCase())
      .slice(0, MAX_CHECKINS)
      .map((a) => ({
        question: a.question,
        name: a.name,
        date: a.date,
        text: cut(a.text, CHECKIN_CHARS),
      }))
    return { events, meetings, tasks, docs, links, checkins }
  }

  /** Links the member saved since `since`; on Mondays also last week's still unread. */
  async #savedLinks(principal: Principal, since: Date, monday: boolean): Promise<CastLink[]> {
    if (!this.#d.links) return []
    const toCast = (status: CastLink['status']) => (l: LinkView) => ({
      title: l.title || l.site || 'An untitled page',
      site: l.site,
      summary: l.summary || l.description,
      status,
    })
    const recent = await this.#d.links.list(principal, {
      view: 'all',
      savedBy: principal.email,
      savedSince: since.toISOString(),
      limit: MAX_LINKS,
    })
    if (!monday) return recent.map(toCast('saved'))
    const weekAgo = new Date(since.getTime() - 7 * 86_400_000).toISOString()
    const unread = (
      await this.#d.links.list(principal, {
        view: 'unread',
        savedBy: principal.email,
        savedSince: weekAgo,
        limit: MAX_LINKS * 4,
      })
    )
      .filter((l) => l.saved < since.toISOString())
      .slice(0, MAX_UNREAD_LINKS)
    return [...recent.map(toCast('saved')), ...unread.map(toCast('unread'))]
  }

  /** Docs other people changed since `since`, in spaces the member can read. */
  async #changedDocs(
    principal: Principal,
    spaces: Array<{ name: string }>,
    since: Date,
  ): Promise<CastDoc[]> {
    const me = principal.email.toLowerCase()
    const docs: CastDoc[] = []
    for (const { name: space } of spaces) {
      if (docs.length >= MAX_DOCS) break
      const commits = await this.#d.git.log(space, { limit: LOG_DEPTH })
      const recent = commits.filter((c) => Date.parse(c.date) >= since.getTime())
      if (recent.length === 0) continue
      // The newest commit before the window; a space whose whole history is in the window
      // compares against its first commit.
      const base =
        commits.find((c) => Date.parse(c.date) < since.getTime()) ??
        (commits.length < LOG_DEPTH ? commits.at(-1) : undefined)
      if (!base) continue
      let looked = 0
      const paths = await this.#d.git.changedPaths(
        space,
        base.oid,
        await this.#d.git.headOid(space),
      )
      for (const path of paths) {
        if (docs.length >= MAX_DOCS) break
        // Markdown documents: not meetings, transcripts, tasks or Hearth's own files.
        if (path.startsWith('.') || path.includes('/.') || !/\.md$/i.test(path)) continue
        const kind = kindOf(path)
        if (kind !== 'docs' && kind !== 'other') continue
        if (++looked > MAX_DOC_LOOKUPS) break
        const history = await this.#d.git.log(space, { path, limit: 20 })
        const by = [
          ...new Set(
            history
              .filter((c) => Date.parse(c.date) >= since.getTime())
              .filter((c) => c.author.email.toLowerCase() !== me)
              .map((c) => c.author.name || c.author.email),
          ),
        ]
        // The member's own edits aren't news to them.
        if (by.length === 0) continue
        const file = await this.#readFile(space, path)
        if (file === null) continue
        docs.push({
          space,
          path,
          title: extractDoc(path, file).title,
          by,
          excerpt: cut(parseFrontmatter(file).body, DOC_CHARS),
        })
      }
    }
    return docs
  }

  // ── nightly ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.#timer || !this.#d.nightly) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
    this.#catchUp = setTimeout(() => void this.tick(), 90_000)
    this.#catchUp.unref()
  }

  async close(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#catchUp) clearTimeout(this.#catchUp)
    this.#timer = null
    this.#catchUp = null
    await this.#running
  }

  tick(): Promise<void> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #tick(): Promise<void> {
    const now = this.#now()
    const start = Math.max(0, this.#d.hour - 1)
    for (const member of await this.#d.members.list()) {
      if (this.#stopping) return
      // Due once a morning: from the start hour until noon (a server that was down catches up).
      const hour = zonedParts(now, validZone(member.tz) ?? 'UTC').hour
      if (hour < start || hour >= 12) continue
      if (!isDue(member.checkedAt, now, member.tz, start)) continue
      // Weekdays only (in the member's zone, on the day the morning belongs to).
      const weekday = localDay(new Date(now.getTime() - start * 3_600_000), member.tz).weekday
      // Retries count per member per morning, so yesterday's failures don't shorten today's.
      const failureKey = `${member.userId} ${localDay(now, member.tz).date}`
      if (weekday === 'Sat' || weekday === 'Sun') {
        await this.#d.members.markChecked(member.userId, now)
        continue
      }
      try {
        const principal = await this.#d.auth.principalForUser(member.userId)
        if (!principal) {
          await this.#d.members.remove(member.userId)
          continue
        }
        await this.#d.spaces.ensurePersonalSpace(principal)
        const { status, episode } = await this.refresh(principal)
        if (status === 'written' && episode) await this.#notify(principal, episode)
        this.#failures.delete(failureKey)
      } catch (err) {
        const failures = (this.#failures.get(failureKey) ?? 0) + 1
        this.#log(
          `briefcast: morning episode for ${member.email} failed (${failures}): ${errorText(err)}`,
        )
        if (failures < NIGHTLY_ATTEMPTS) {
          this.#failures.set(failureKey, failures)
          continue
        }
        this.#failures.delete(failureKey)
      }
      await this.#d.members.markChecked(member.userId, now)
    }
    await this.cleanup().catch((err) =>
      this.#log(`briefcast: audio clean-up failed: ${errorText(err)}`),
    )
  }

  /** Deletes audio older than 30 days; the scripts stay in Git. */
  async cleanup(): Promise<number> {
    if (!this.#d.audio) return 0
    const cutoff = new Date(this.#now().getTime() - AUDIO_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const keys = await this.#d.state.audioBefore(cutoff)
    for (const key of keys) await this.#d.audio.delete(key)
    await this.#d.state.forgetAudio(keys)
    return keys.length
  }

  async #notify(principal: Principal, episode: Episode): Promise<void> {
    if (!this.#d.push) return
    const { store, sender } = this.#d.push
    for (const s of await store.subscribers()) {
      if (s.principal.userId !== principal.userId) continue
      try {
        const result = await sender.send(s.subscription, {
          title: 'Your Briefcast is ready',
          body: episode.title,
          url: '/briefcast',
          tag: `briefcast-${episode.date}`,
        })
        if (result === 'gone') await store.unsubscribe(s.subscription.endpoint)
      } catch (err) {
        this.#log(`briefcast: notification failed: ${errorText(err)}`)
      }
    }
  }

  // ── podcast feed ─────────────────────────────────────────────────────────

  async makeFeed(principal: Principal): Promise<string> {
    await this.#personal(principal)
    return this.#feedUrl(await this.#d.state.rotateFeed(principal.userId, principal.email))
  }

  async removeFeed(principal: Principal): Promise<void> {
    await this.#d.state.removeFeed(principal.userId)
  }

  /** The RSS for a feed token: the last 30 days of episodes that have audio. */
  async feed(token: string): Promise<string> {
    const principal = await this.#feedOwner(token)
    const space = await this.#personal(principal)
    const cutoff = new Date(this.#now().getTime() - AUDIO_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const items: string[] = []
    for (const summary of (await this.#list(space)).filter((e) => e.audio && e.date >= cutoff)) {
      const file = await this.#readFile(space, episodePath(summary.date))
      const bytes = file ? Number(parseFrontmatter(file).data.audio_bytes ?? 0) : 0
      const episode = await this.#read(space, summary.date)
      // A remade episode is a new item, so podcast apps download the new audio.
      const version = Date.parse(summary.generated) || 0
      const url = `${this.#d.publicUrl.replace(/\/$/, '')}/api/briefcast/feed/${token}/${summary.date}.mp3?v=${version}`
      items.push(
        [
          '<item>',
          `<title>${xml(summary.title)}</title>`,
          `<guid isPermaLink="false">briefcast-${xml(principal.userId)}-${summary.date}-${version}</guid>`,
          `<pubDate>${new Date(summary.generated || `${summary.date}T06:00:00Z`).toUTCString()}</pubDate>`,
          `<enclosure url="${xml(url)}" length="${bytes}" type="audio/mpeg"/>`,
          summary.seconds ? `<itunes:duration>${summary.seconds}</itunes:duration>` : '',
          `<description>${xml(cut(episode?.script ?? '', 3_000))}</description>`,
          '</item>',
        ]
          .filter(Boolean)
          .join(''),
      )
    }
    const name = this.#d.org ? `Briefcast · ${this.#d.org}` : 'Briefcast'
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">',
      '<channel>',
      `<title>${xml(`${name} for ${principal.name}`)}</title>`,
      `<link>${xml(`${this.#d.publicUrl.replace(/\/$/, '')}/briefcast`)}</link>`,
      '<description>Your private morning briefing.</description>',
      `<atom:link href="${xml(this.#feedUrl(token))}" rel="self" type="application/rss+xml"/>`,
      '<language>en</language>',
      `<itunes:author>${xml(this.#d.org || 'Briefcast')}</itunes:author>`,
      '<itunes:category text="Business"/>',
      '<itunes:block>Yes</itunes:block>',
      '<itunes:explicit>false</itunes:explicit>',
      ...items,
      '</channel>',
      '</rss>',
    ].join('\n')
  }

  async feedAudio(token: string, date: string): Promise<Uint8Array> {
    const principal = await this.#feedOwner(token)
    return this.#audioFor(principal.userId, assertDate(date))
  }

  async #feedOwner(token: string): Promise<Principal> {
    const refused = new HearthError('not_found', 'No such feed')
    const userId = token.length >= 16 ? await this.#d.state.userForToken(token) : null
    if (!userId) throw refused
    const principal = await this.#d.auth.principalForUser(userId)
    if (!principal) throw refused
    // Podcast apps poll without a session, so nothing else has provisioned the space since a
    // restart.
    await this.#d.spaces.ensurePersonalSpace(principal)
    return principal
  }

  #feedUrl(token: string): string {
    return `${this.#d.publicUrl.replace(/\/$/, '')}/api/briefcast/feed/${token}.xml`
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async #audioFor(userId: string, date: string): Promise<Uint8Array> {
    const found = this.#d.audio ? await this.#d.audio.get(audioKey(userId, date)) : null
    if (!found) throw new HearthError('not_found', 'This episode’s audio isn’t available')
    return new Uint8Array(await new Response(found.body).arrayBuffer())
  }

  async #list(space: string): Promise<EpisodeSummary[]> {
    const entries = (await this.#d.git.listTree(space, EPISODE_DIR))
      .filter((e) => e.type === 'file' && /\/\d{4}-\d{2}-\d{2}\.md$/.test(e.path))
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, 60)
    const out: EpisodeSummary[] = []
    for (const e of entries) {
      const date = e.path.slice(-13, -3)
      const episode = await this.#read(space, date)
      if (episode) {
        const { date: d, title, generated, seconds, audio } = episode
        out.push({ date: d, title, generated, seconds, audio })
      }
    }
    return out
  }

  async #read(space: string, date: string): Promise<Episode | null> {
    const file = await this.#readFile(space, episodePath(date))
    if (file === null) return null
    const { data, body } = parseFrontmatter(file)
    const titleLine = /^\s*# ([^\n]*)\n+/.exec(body)
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      date,
      title: titleLine?.[1]?.trim() || `Briefcast for ${date}`,
      generated: typeof data.generated === 'string' ? data.generated : '',
      seconds: typeof data.seconds === 'number' ? data.seconds : null,
      audio: num(data.audio_bytes) > 0 && date >= this.#audioCutoff(),
      audioExpired: num(data.audio_bytes) > 0 && date < this.#audioCutoff(),
      script: body.replace(/^\s*# [^\n]*\n+/, '').trim(),
      model: typeof data.model === 'string' ? data.model : '',
      voice: typeof data.voice === 'string' ? data.voice : '',
      counts: {
        events: num(data.events),
        meetings: num(data.meetings),
        tasks: num(data.tasks),
        docs: num(data.docs),
        links: num(data.links),
        checkins: num(data.checkins),
      },
    }
  }

  async #readFile(space: string, path: string): Promise<string | null> {
    try {
      return (await this.#d.git.readFile(space, path)).content
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
  }

  async #commit(
    principal: Principal,
    space: string,
    path: string,
    content: string,
    via?: string,
  ): Promise<void> {
    const message = withVia(
      formatCommitMessage({ app: 'briefcast', verb: 'write', title: 'Briefcast' }),
      via,
    )
    const result = await this.#d.git.commit(space, {
      changes: [{ path, content }],
      author: { name: principal.name, email: principal.email },
      message,
    })
    if (result.status === 'conflict') {
      throw new HearthError('conflict', 'Your Briefcast changed while it was being saved')
    }
    await this.#d.syncer.afterHeadChanged(space)
  }

  async #personal(principal: Principal): Promise<string> {
    // Audio and feeds are keyed by user id; a principal without one can't have them.
    if (principal.userId === '')
      throw new HearthError('forbidden', 'Briefcast needs a signed-in member')
    const own = (await this.#d.spaces.visibleSpaces(principal)).find((s) => s.kind === 'personal')
    if (!own) throw new HearthError('forbidden', 'Your personal space isn’t available')
    return own.name
  }

  /** The oldest day whose audio is still kept. */
  #audioCutoff(): string {
    return new Date(this.#now().getTime() - AUDIO_DAYS * 86_400_000).toISOString().slice(0, 10)
  }

  #voiced(): boolean {
    return this.#d.speaker.kind !== 'none' && this.#d.audio !== null
  }

  #allowForced(email: string): void {
    const now = this.#now().getTime()
    const recent = (this.#forced.get(email) ?? []).filter((t) => now - t < 86_400_000)
    const last = recent.at(-1)
    if (last !== undefined && now - last < this.#d.forcedGapMs) {
      throw new HearthError('rate_limited', 'A Briefcast was just made. Try again in a minute.')
    }
    if (recent.length >= FORCED_PER_DAY) {
      throw new HearthError(
        'rate_limited',
        'You’ve made a lot of Briefcasts today. Try again tomorrow.',
      )
    }
    this.#forced.set(email, [...recent, now])
  }
}

export function episodePath(date: string): string {
  return `${EPISODE_DIR}/${date}.md`
}

/** The audio object's key: the member's id hashed, so it is safe in a path and not guessable. */
export function audioKey(userId: string, date: string): string {
  const who = createHash('sha256').update(userId).digest('hex').slice(0, 24)
  return `briefcast/${who}/${date}.mp3`
}

function titleFor(dayLabel: string): string {
  return `Briefcast for ${dayLabel}`
}

/** The member's local date, weekday ("Mon") and a spoken label ("Thursday, November 12"). */
export function localDay(
  instant: Date,
  tz: string,
): { date: string; weekday: string; label: string } {
  const zone = validZone(tz) ?? 'UTC'
  const p = zonedParts(instant, zone)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(
    instant,
  )
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instant)
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, weekday, label }
}

function assertDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new HearthError('not_found', 'No Briefcast for that day')
  return date
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

function xml(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Control characters other than tab and newline aren't allowed in XML 1.0.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  )
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
