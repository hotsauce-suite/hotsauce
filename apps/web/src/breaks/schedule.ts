// When the next screen break comes (docs/PLAN-breaks.md B3 to B6). Pure: the runner calls `step`
// about once a second with what it sees, and the actions when the member presses a button. The
// Mac app keeps the same rules in Swift (apps/dictate-mac BreakSchedule.swift).

/** The heads-up shows this long before a break. */
export const WARN_MS = 10_000
/** A break held off by a recording or meeting comes this long after it ends. */
export const GRACE_MS = 60_000
/** "5 more minutes". */
export const SNOOZE_MS = 5 * 60_000

export interface ScheduleSettings {
  everyMinutes: number
  lengthSeconds: number
}

export type BreakPhase =
  | { kind: 'counting' }
  /** The heads-up: the break starts at `startsAt`. */
  | { kind: 'warning'; startsAt: number }
  | { kind: 'break'; endsAt: number }

export interface BreakSchedule {
  /** When the next break starts (counting) or would have (warning, break). */
  dueAt: number
  phase: BreakPhase
}

export interface StepInput {
  now: number
  /** A recording, dictation, screen share or calendar meeting is on (B4). */
  busy: boolean
  /** How long the member has been away (no input, screen locked, computer asleep) (B5). */
  idleMs: number
  /** Inside the working hours, or none set (B6). */
  inHours: boolean
}

export type BreakEvent = 'warn' | 'start' | 'end' | 'reset'

export interface StepResult {
  schedule: BreakSchedule
  event: BreakEvent | null
}

const everyMs = (s: ScheduleSettings) => s.everyMinutes * 60_000
const lengthMs = (s: ScheduleSettings) => s.lengthSeconds * 1000

/** A fresh count: breaks just turned on, the page loaded, or the every changed (B3). */
export function startSchedule(settings: ScheduleSettings, now: number): BreakSchedule {
  return { dueAt: now + everyMs(settings), phase: { kind: 'counting' } }
}

function counting(dueAt: number): BreakSchedule {
  return { dueAt, phase: { kind: 'counting' } }
}

export function step(
  schedule: BreakSchedule,
  settings: ScheduleSettings,
  input: StepInput,
): StepResult {
  const { now, busy, idleMs, inHours } = input
  const { phase } = schedule
  if (phase.kind === 'break') {
    if (now >= phase.endsAt) return { schedule: counting(now + everyMs(settings)), event: 'end' }
    return { schedule, event: null }
  }
  // Away for a break's length or longer: that was the break (B5).
  if (idleMs >= lengthMs(settings))
    return { schedule: counting(now + everyMs(settings)), event: 'reset' }
  // Outside working hours the count stands still at a full interval (B6).
  if (!inHours) {
    const dueAt = now + everyMs(settings)
    return {
      schedule: counting(dueAt),
      event: phase.kind === 'warning' ? 'reset' : null,
    }
  }
  if (busy) {
    // Held: never sooner than a minute after it ends (B4).
    const dueAt = Math.max(schedule.dueAt, now + GRACE_MS)
    if (phase.kind === 'warning') return { schedule: counting(dueAt), event: 'reset' }
    return { schedule: counting(dueAt), event: null }
  }
  if (phase.kind === 'warning') {
    if (now >= phase.startsAt)
      return {
        schedule: {
          dueAt: phase.startsAt,
          phase: { kind: 'break', endsAt: now + lengthMs(settings) },
        },
        event: 'start',
      }
    return { schedule, event: null }
  }
  if (now >= schedule.dueAt - WARN_MS) {
    // Already past due (the page was asleep): warn now, break in the usual 10 seconds.
    const startsAt = now > schedule.dueAt ? now + WARN_MS : schedule.dueAt
    return { schedule: { dueAt: startsAt, phase: { kind: 'warning', startsAt } }, event: 'warn' }
  }
  return { schedule, event: null }
}

/** "Start now" on the heads-up, or "Take a break now" in Settings. */
export function startNow(settings: ScheduleSettings, now: number): BreakSchedule {
  return { dueAt: now, phase: { kind: 'break', endsAt: now + lengthMs(settings) } }
}

/** Skip: the count starts over (B3). */
export function skip(settings: ScheduleSettings, now: number): BreakSchedule {
  return counting(now + everyMs(settings))
}

/** 5 more minutes (B3). */
export function snooze(now: number): BreakSchedule {
  return counting(now + SNOOZE_MS)
}
