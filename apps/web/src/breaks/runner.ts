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
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
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
  /** Tells the other tabs (a non-leader tab asks the leader to start a break now). */
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

function readSchedule(storage: RunnerDeps['storage']): BreakSchedule | null {
  try {
    const raw = storage?.getItem(SCHEDULE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as BreakSchedule
    if (typeof s?.dueAt !== 'number' || !s.phase || typeof s.phase.kind !== 'string') return null
    return s
  } catch {
    return null
  }
}

export function createBreakRunner(deps: RunnerDeps): BreakRunner {
  const listeners = new Set<() => void>()
  let leader = false
  let schedule: BreakSchedule | null = null
  let lastTick = 0
  let timer: unknown = null
  /** The every and length the count was started with: a change restarts it (B3). */
  let countedWith = ''
  let view: BreakView = { phase: { kind: 'counting' }, leader: false, settings: deps.settings() }

  function emit() {
    const phase = leader && schedule ? schedule.phase : ({ kind: 'counting' } as const)
    view = { phase, leader, settings: deps.settings() }
    for (const l of listeners) l()
  }

  function save() {
    try {
      if (schedule) deps.storage?.setItem(SCHEDULE_KEY, JSON.stringify(schedule))
    } catch {
      // Nowhere to keep it: a new tab starts a fresh count.
    }
  }

  function key(s: BreakSettings) {
    return `${s.everyMinutes}/${s.lengthSeconds}`
  }

  function tick() {
    const settings = deps.settings()
    const now = deps.now()
    // A long gap between ticks: the computer slept, which counts as time away (B5).
    const gap = lastTick ? now - lastTick - TICK_MS : 0
    lastTick = now
    if (!settings.on) {
      if (schedule) {
        schedule = null
        countedWith = ''
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
      idleMs: Math.max(0, gap),
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

  function lead(): Promise<void> {
    leader = true
    lastTick = 0
    tick()
    emit()
    timer = deps.setInterval(tick, TICK_MS)
    // Held until the tab closes.
    return new Promise(() => {})
  }

  function act(next: (s: BreakSettings, now: number) => BreakSchedule) {
    const settings = deps.settings()
    if (!settings.on) return
    schedule = next(settings, deps.now())
    countedWith = key(settings)
    save()
    emit()
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
        mac.postMessage({ type: 'busy', busy: wasBusy })
        timer = deps.setInterval(() => {
          const busy = deps.busy()
          if (busy !== wasBusy) {
            wasBusy = busy
            mac.postMessage({ type: 'busy', busy })
          }
        }, TICK_MS)
      } else if (deps.lock) deps.lock(lead)
      else void lead()
      const offChannel = deps.channel?.listen((m) => {
        if (leader && m === 'startNow') act((st, now) => startNowSchedule(st, now))
      })
      return () => {
        offSettings()
        offChannel?.()
        if (timer !== null) deps.clearInterval(timer)
        timer = null
        started = false
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
    },
    snooze() {
      if (leader) act((_s, now) => snoozeSchedule(now))
    },
  }
}
