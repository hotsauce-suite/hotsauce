// Runs screen breaks in the browser (docs/PLAN-breaks.md B3 to B8, B11). One tab at a time keeps
// the timer (a Web Lock; closing that tab hands it on), and the count is kept in this browser so
// the next tab carries on where it left off. Inside a Mac app that has breaks of its own, the
// page runs nothing: it hands the app the settings and its recording state, and the app shows the
// break over every display.

import { type BreakSettings, withinWorkingHours } from '@hotsauce/format'
import {
  type BreakPhase,
  type BreakSchedule,
  skip as skipSchedule,
  snooze as snoozeSchedule,
  startNow as startNowSchedule,
  startSchedule,
  step,
} from './schedule'

export const BREAKS_LOCK = 'hotsauce-breaks'
export const SCHEDULE_KEY = 'hotsauce:breaks-schedule'
export const MAC_BREAKS_HANDLER = 'hotsauceBreaks'
const TICK_MS = 1000
/**
 * A gap between ticks this long means the computer slept. Shorter gaps are a hidden tab's timers
 * being slowed down (Chrome runs them once a minute after a few minutes hidden), not time away.
 */
export const AWAY_GAP_MS = 3 * 60_000
/** Inside the Mac app, "busy" is said again this often while it lasts, so a page that closes
 * mid-recording can't hold breaks for good: the app forgets it after a few missed beats. */
export const BUSY_BEAT_MS = 5000
/** A heads-up this far past its start, sent by a leader that has since gone quiet, is stale. */
const STALE_MS = 5000

export interface BreakView {
  phase: BreakPhase
  /** This tab keeps the timer (and so shows the break). */
  leader: boolean
  settings: BreakSettings
}

export interface RunnerDeps {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** Waits for the one-tab lock; calls `run` once held, and holds it until the returned promise ends. */
  lock: ((run: () => Promise<void>) => void) | null
  /** A recording, dictation, screen share or calendar meeting is on. */
  busy: () => boolean
  settings: () => BreakSettings
  subscribeSettings: (fn: () => void) => () => void
  /** The Mac app's handler, when it has breaks of its own. */
  mac: { postMessage(message: unknown): unknown } | null
  /** Played when a break ends (chime on). */
  chime: () => void
  /** The break started while the page was hidden. */
  notifyHidden: (settings: BreakSettings) => void
  hidden: () => boolean
  /**
   * Talks to the other tabs: the leader sends its schedule so every tab shows the break, and the
   * other tabs ask the leader to start, skip or snooze one.
   */
  channel: {
    post(message: unknown): void
    listen(fn: (message: unknown) => void): () => void
  } | null
}

export interface BreakRunner {
  getView(): BreakView
  subscribe(listener: () => void): () => void
  start(): () => void
  startNow(): void
  skip(): void
  snooze(): void
}

type ChannelMessage =
  | 'startNow'
  | 'skip'
  | 'snooze'
  | { type: 'schedule'; schedule: BreakSchedule | null }

function isSchedule(s: unknown): s is BreakSchedule {
  const v = s as BreakSchedule | null
  return typeof v?.dueAt === 'number' && !!v.phase && typeof v.phase.kind === 'string'
}

function readSchedule(storage: RunnerDeps['storage']): BreakSchedule | null {
  try {
    const raw = storage?.getItem(SCHEDULE_KEY)
    if (!raw) return null
    const s: unknown = JSON.parse(raw)
    return isSchedule(s) ? s : null
  } catch {
    return null
  }
}

export function createBreakRunner(deps: RunnerDeps): BreakRunner {
  const listeners = new Set<() => void>()
  let leader = false
  let schedule: BreakSchedule | null = null
  /** In a tab that isn't the leader: the leader's schedule, as it last sent it. */
  let shared: BreakSchedule | null = null
  let lastTick = 0
  let timer: unknown = null
  /** The every and length the count was started with: a change restarts it (B3). */
  let countedWith = ''
  let view: BreakView = { phase: { kind: 'counting' }, leader: false, settings: deps.settings() }

  function shownPhase(): BreakPhase {
    const s = leader ? schedule : shared
    if (!s || !deps.settings().on) return { kind: 'counting' }
    // A schedule from a leader that has since closed can be out of date.
    if (!leader && s.phase.kind === 'break' && s.phase.endsAt <= deps.now())
      return { kind: 'counting' }
    if (!leader && s.phase.kind === 'warning' && s.phase.startsAt + STALE_MS <= deps.now())
      return { kind: 'counting' }
    return s.phase
  }

  function emit() {
    view = { phase: shownPhase(), leader, settings: deps.settings() }
    for (const l of listeners) l()
  }

  function save() {
    try {
      if (schedule) deps.storage?.setItem(SCHEDULE_KEY, JSON.stringify(schedule))
      else deps.storage?.removeItem(SCHEDULE_KEY)
    } catch {
      // Nowhere to keep it: a new tab starts a fresh count.
    }
    deps.channel?.post({ type: 'schedule', schedule } satisfies ChannelMessage)
  }

  function key(s: BreakSettings) {
    return `${s.everyMinutes}/${s.lengthSeconds}`
  }

  function tick() {
    const settings = deps.settings()
    const now = deps.now()
    // A long gap between ticks: the computer slept, which counts as time away (B5).
    const gap = lastTick ? now - lastTick - TICK_MS : 0
    const away = gap >= AWAY_GAP_MS ? gap : 0
    lastTick = now
    if (!settings.on) {
      if (schedule || countedWith) {
        // Off forgets the count: turning breaks on again starts a fresh one (B3).
        schedule = null
        countedWith = ''
        save()
        emit()
      }
      return
    }
    if (!schedule || countedWith !== key(settings)) {
      const kept = countedWith === '' ? readSchedule(deps.storage) : null
      schedule =
        kept && kept.phase.kind === 'counting' && kept.dueAt > now
          ? kept
          : startSchedule(settings, now)
      countedWith = key(settings)
      save()
      emit()
    }
    const r = step(schedule, settings, {
      now,
      busy: deps.busy(),
      idleMs: away,
      inHours: withinWorkingHours(settings.hours, new Date(now)),
    })
    const changed = r.schedule !== schedule
    schedule = r.schedule
    if (r.event === 'start' && deps.hidden()) deps.notifyHidden(settings)
    if (r.event === 'end' && settings.chime) deps.chime()
    if (changed) {
      save()
      emit()
    }
  }

  /** Ends the current run (the shell unmounted): lets go of the lock and the timer. */
  let release: (() => void) | null = null
  let run = 0

  function lead(mine: number): Promise<void> {
    // Granted after this run already ended (React's dev double effect): hand the lock straight on.
    if (mine !== run) return Promise.resolve()
    leader = true
    lastTick = 0
    countedWith = ''
    tick()
    emit()
    timer = deps.setInterval(tick, TICK_MS)
    // Held until the tab closes or the shell unmounts.
    return new Promise((resolve) => {
      release = resolve
    })
  }

  function act(next: (s: BreakSettings, now: number) => BreakSchedule) {
    const settings = deps.settings()
    if (!settings.on) return
    schedule = next(settings, deps.now())
    countedWith = key(settings)
    save()
    emit()
  }

  /** A tab that isn't the leader: hide the break here at once and ask the leader to act. */
  function hideAndAsk(m: 'skip' | 'snooze') {
    if (!shared) return
    shared = null
    emit()
    deps.channel?.post(m satisfies ChannelMessage)
  }

  let started = false
  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (started) return () => {}
      started = true
      const mine = ++run
      shared = deps.mac ? null : readSchedule(deps.storage)
      const offSettings = deps.subscribeSettings(() => {
        if (deps.mac) deps.mac.postMessage({ type: 'settings', settings: deps.settings() })
        else if (leader) tick()
        emit()
      })
      if (deps.mac) {
        // The app keeps the timer; the page tells it what it knows (B11).
        const mac = deps.mac
        mac.postMessage({ type: 'settings', settings: deps.settings() })
        let wasBusy = deps.busy()
        let saidAt = deps.now()
        mac.postMessage({ type: 'busy', busy: wasBusy })
        timer = deps.setInterval(() => {
          const busy = deps.busy()
          const now = deps.now()
          if (busy !== wasBusy || (busy && now - saidAt >= BUSY_BEAT_MS)) {
            wasBusy = busy
            saidAt = now
            mac.postMessage({ type: 'busy', busy })
          }
        }, TICK_MS)
      } else if (deps.lock) deps.lock(() => lead(mine))
      else void lead(mine)
      const offChannel = deps.channel?.listen((raw) => {
        const m = raw as ChannelMessage
        if (leader) {
          if (m === 'startNow') act((st, now) => startNowSchedule(st, now))
          else if (m === 'skip') act(skipSchedule)
          else if (m === 'snooze') act((_s, now) => snoozeSchedule(now))
        } else if (typeof m === 'object' && m?.type === 'schedule') {
          shared = m.schedule === null || isSchedule(m.schedule) ? m.schedule : shared
          emit()
        }
      })
      return () => {
        offSettings()
        offChannel?.()
        if (timer !== null) deps.clearInterval(timer)
        timer = null
        started = false
        run++
        leader = false
        release?.()
        release = null
        emit()
      }
    },
    startNow() {
      if (deps.mac) {
        deps.mac.postMessage({ type: 'startNow' })
        return
      }
      if (!leader) {
        deps.channel?.post('startNow')
        return
      }
      act((s, now) => startNowSchedule(s, now))
    },
    skip() {
      if (leader) act(skipSchedule)
      else hideAndAsk('skip')
    },
    snooze() {
      if (leader) act((_s, now) => snoozeSchedule(now))
      else hideAndAsk('snooze')
    },
  }
}
