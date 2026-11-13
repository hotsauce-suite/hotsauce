// Check-ins (ARCHITECTURE §24): a scheduled team question. The question is `checkins/<id>.md` in
// the team space; each answer is `checkins/<id>/<date>/<answer id>.md`, its replies in its
// frontmatter; the round's summary, once posted, is `checkins/<id>/<date>/summary.md`.

import { z } from 'zod'
import { WEEKDAYS, type Weekday } from './booking.js'

export const CHECKINS_FOLDER = 'checkins'
export const MAX_CHECKIN_QUESTION = 300
export const MAX_CHECKIN_ANSWER = 10_000
export const MAX_CHECKIN_REPLY = 2_000
export const MAX_CHECKIN_REPLIES = 200

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const isCheckinId = (id: string) => ULID.test(id)
export const isCheckinDate = (d: string) =>
  DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
export const checkinPath = (id: string) => `${CHECKINS_FOLDER}/${id}.md`
export const checkinRoundFolder = (id: string, date: string) => `${CHECKINS_FOLDER}/${id}/${date}/`
export const checkinAnswerPath = (id: string, date: string, answerId: string) =>
  `${CHECKINS_FOLDER}/${id}/${date}/${answerId}.md`
export const checkinSummaryPath = (id: string, date: string) =>
  `${CHECKINS_FOLDER}/${id}/${date}/summary.md`

/** The two check-ins a team starts with (Basecamp's defaults, reworded). */
export const DEFAULT_CHECKINS: ReadonlyArray<{ title: string; days: Weekday[]; time: string }> = [
  { title: 'What will you get done this week?', days: ['mon'], time: '09:00' },
  { title: 'What got done, and what’s stuck?', days: ['fri'], time: '15:00' },
]

/** A question's frontmatter. Unknown keys pass through. */
export const CheckinFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('checkin'),
  title: z.string().min(1).max(MAX_CHECKIN_QUESTION),
  days: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .transform((d) => WEEKDAYS.filter((w) => d.includes(w))),
  time: z.string().regex(TIME),
  /** The zone of whoever set it up: the summary's deadline, and anyone whose zone isn't known. */
  tz: z.string().default('UTC'),
  /** Emails of members not asked. */
  skip: z.array(z.string()).default([]),
  /** The chat room (§21.5) the summary goes to; null for none. */
  room: z.string().nullable().default(null),
  paused: z.boolean().default(false),
  created: z.string(),
  created_by: z.string(),
  updated: z.string().optional(),
  updated_by: z.string().optional(),
})
export type CheckinFrontmatter = z.infer<typeof CheckinFrontmatter>

export const CheckinReply = z.object({
  id: z.string().regex(ULID),
  by: z.string(),
  name: z.string(),
  at: z.string(),
  text: z.string(),
})
export type CheckinReply = z.infer<typeof CheckinReply>

/** An answer's frontmatter; the body is the answer. */
export const CheckinAnswerFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('checkin-answer'),
  checkin: z.string().regex(ULID),
  date: z.string().regex(DATE),
  title: z.string().optional(),
  submitted: z.string(),
  submitted_by: z.string(),
  name: z.string(),
  edited: z.string().optional(),
  replies: z.array(CheckinReply).default([]),
})
export type CheckinAnswerFrontmatter = z.infer<typeof CheckinAnswerFrontmatter>

/** A round's summary, written once when it is posted. The body is what was posted. */
export const CheckinSummaryFrontmatter = z.looseObject({
  type: z.literal('checkin-summary'),
  checkin: z.string().regex(ULID),
  date: z.string().regex(DATE),
  title: z.string().optional(),
  written: z.string(),
  answered: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  room: z.string().nullable().default(null),
  posted: z.boolean().default(false),
})
export type CheckinSummaryFrontmatter = z.infer<typeof CheckinSummaryFrontmatter>

/** "Mondays at 9:00", "Mon, Wed and Fri at 15:30". */
export function scheduleLabel(days: readonly Weekday[], time: string): string {
  const names: Record<Weekday, string> = {
    sun: 'Sunday',
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
  }
  const at = clockLabel(time)
  if (days.length === 7) return `Every day at ${at}`
  if (days.length === 5 && !days.includes('sat') && !days.includes('sun'))
    return `Every weekday at ${at}`
  if (days.length === 1) return `${names[days[0] as Weekday]}s at ${at}`
  const short = days.map((d) => names[d].slice(0, 3))
  return `${short.slice(0, -1).join(', ')} and ${short.at(-1)} at ${at}`
}

/** "09:00" → "9 AM", "15:30" → "3:30 PM". */
export function clockLabel(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}
