// Screen breaks (docs/PLAN-breaks.md): how often a member wants a short break from the screen,
// for how long, and how it looks. One JSON file per member, `.hearth/breaks.json` in their
// personal space, so the Mac app and every browser share it. Everything here is pure.

export const BREAKS_PATH = '.hearth/breaks.json'

export const BREAK_ANIMATIONS = ['breathe', 'clouds', 'waves'] as const
export type BreakAnimation = (typeof BREAK_ANIMATIONS)[number]

/** Minutes between breaks, inclusive bounds. */
export const BREAK_EVERY_MIN = 5
export const BREAK_EVERY_MAX = 120
/** Seconds a break lasts, inclusive bounds. */
export const BREAK_LENGTH_MIN = 10
export const BREAK_LENGTH_MAX = 900

export interface WorkingHours {
  /** "HH:MM", 24-hour, local time. */
  start: string
  end: string
  /** Days breaks may come: 0 is Sunday, 6 Saturday. */
  days: number[]
}

export interface BreakSettings {
  schema: 1
  on: boolean
  everyMinutes: number
  lengthSeconds: number
  animation: BreakAnimation
  /** A soft chime when the break ends. */
  chime: boolean
  /** Only between these hours; null for any time. */
  hours: WorkingHours | null
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: '09:00',
  end: '18:00',
  days: [1, 2, 3, 4, 5],
}

export function defaultBreakSettings(): BreakSettings {
  return {
    schema: 1,
    on: false,
    everyMinutes: 20,
    lengthSeconds: 20,
    animation: 'breathe',
    chime: true,
    hours: null,
  }
}

export class BreakSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BreakSettingsError'
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

function hoursOf(v: unknown): WorkingHours | null | undefined {
  if (v === null) return null
  if (!v || typeof v !== 'object') return undefined
  const h = v as Record<string, unknown>
  if (typeof h.start !== 'string' || !TIME.test(h.start)) return undefined
  if (typeof h.end !== 'string' || !TIME.test(h.end)) return undefined
  if (h.start === h.end) return undefined
  if (!Array.isArray(h.days) || !h.days.every((d) => isInt(d, 0, 6))) return undefined
  const days = [...new Set(h.days as number[])].sort((a, b) => a - b)
  return { start: h.start, end: h.end, days }
}

/**
 * Reads a saved file (text or parsed JSON) leniently: a value that is missing, unknown or out of
 * range falls back to its default, so a hand-edited file never stops breaks working (B1).
 */
export function readBreakSettings(input: unknown): BreakSettings {
  const d = defaultBreakSettings()
  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      return d
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d
  const r = raw as Record<string, unknown>
  const hours = hoursOf(r.hours)
  return {
    schema: 1,
    on: typeof r.on === 'boolean' ? r.on : d.on,
    everyMinutes: isInt(r.everyMinutes, BREAK_EVERY_MIN, BREAK_EVERY_MAX)
      ? r.everyMinutes
      : d.everyMinutes,
    lengthSeconds: isInt(r.lengthSeconds, BREAK_LENGTH_MIN, BREAK_LENGTH_MAX)
      ? r.lengthSeconds
      : d.lengthSeconds,
    animation: BREAK_ANIMATIONS.includes(r.animation as BreakAnimation)
      ? (r.animation as BreakAnimation)
      : d.animation,
    chime: typeof r.chime === 'boolean' ? r.chime : d.chime,
    hours: hours === undefined ? d.hours : hours,
  }
}

/** Validates what a member sends to save: anything wrong is refused, with what was wrong (B2). */
export function parseBreakSettings(input: unknown): BreakSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BreakSettingsError('Send the break settings as an object')
  const r = input as Record<string, unknown>
  const known = new Set(['schema', 'on', 'everyMinutes', 'lengthSeconds', 'animation', 'chime', 'hours'])
  for (const key of Object.keys(r)) {
    if (!known.has(key)) throw new BreakSettingsError(`Unknown setting "${key}"`)
  }
  if (r.schema !== undefined && r.schema !== 1) throw new BreakSettingsError('Unknown schema')
  if (typeof r.on !== 'boolean') throw new BreakSettingsError('"on" must be true or false')
  if (!isInt(r.everyMinutes, BREAK_EVERY_MIN, BREAK_EVERY_MAX))
    throw new BreakSettingsError(
      `"everyMinutes" must be a whole number from ${BREAK_EVERY_MIN} to ${BREAK_EVERY_MAX}`,
    )
  if (!isInt(r.lengthSeconds, BREAK_LENGTH_MIN, BREAK_LENGTH_MAX))
    throw new BreakSettingsError(
      `"lengthSeconds" must be a whole number from ${BREAK_LENGTH_MIN} to ${BREAK_LENGTH_MAX}`,
    )
  if (!BREAK_ANIMATIONS.includes(r.animation as BreakAnimation))
    throw new BreakSettingsError(`"animation" must be one of ${BREAK_ANIMATIONS.join(', ')}`)
  if (typeof r.chime !== 'boolean') throw new BreakSettingsError('"chime" must be true or false')
  const hours = r.hours === undefined ? null : hoursOf(r.hours)
  if (hours === undefined)
    throw new BreakSettingsError(
      '"hours" must be null or {start: "HH:MM", end: "HH:MM", days: [0-6]} with different times',
    )
  return {
    schema: 1,
    on: r.on,
    everyMinutes: r.everyMinutes as number,
    lengthSeconds: r.lengthSeconds as number,
    animation: r.animation as BreakAnimation,
    chime: r.chime,
    hours,
  }
}

export function serializeBreakSettings(s: BreakSettings): string {
  return `${JSON.stringify(
    {
      schema: 1,
      on: s.on,
      everyMinutes: s.everyMinutes,
      lengthSeconds: s.lengthSeconds,
      animation: s.animation,
      chime: s.chime,
      hours: s.hours,
    },
    null,
    2,
  )}\n`
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/**
 * Whether `at` (local time) falls inside the working hours. Hours that cross midnight (22:00 to
 * 06:00) belong to the day they start on. No hours: always inside (B6).
 */
export function withinWorkingHours(hours: WorkingHours | null, at: Date): boolean {
  if (!hours) return true
  const start = minutesOf(hours.start)
  const end = minutesOf(hours.end)
  const now = at.getHours() * 60 + at.getMinutes()
  const day = at.getDay()
  if (start < end) return hours.days.includes(day) && now >= start && now < end
  // Crosses midnight: the evening part is today's, the early part yesterday's.
  if (now >= start) return hours.days.includes(day)
  if (now < end) return hours.days.includes((day + 6) % 7)
  return false
}
