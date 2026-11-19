// The page's one break runner, with the real browser around it (docs/PLAN-breaks.md).

import { calendarApi } from '../api/calendar'
import type { CalendarEvent } from '../api/types'
import { getLive } from '../apps/meetings/live/liveState'
import { music } from '../music/player'
import { BREAKS_LOCK, type BreakRunner, createBreakRunner, MAC_BREAKS_HANDLER } from './runner'
import { breakSettings, lengthLabel, subscribeBreakSettings } from './settings'

const CALENDAR_REFRESH_MS = 5 * 60_000
/** Longer than this is a day marker or a block of focus time, not a meeting. */
const LONGEST_MEETING_MS = 8 * 3600_000

let events: CalendarEvent[] = []
let calendarFetchedAt = 0

/** Keeps today's meetings with other people at hand, refreshed every few minutes. */
function refreshCalendar(now: number) {
  if (now - calendarFetchedAt < CALENDAR_REFRESH_MS) return
  calendarFetchedAt = now
  const from = new Date(now - 12 * 3600_000).toISOString()
  const to = new Date(now + 12 * 3600_000).toISOString()
  calendarApi
    .upcoming({ from, to })
    .then((list) => {
      events = list
    })
    .catch(() => {
      // No calendar connected, or offline: meetings just don't hold breaks.
    })
}

/** A meeting with someone else is on now (B4). */
export function inMeeting(list: CalendarEvent[], now: number): boolean {
  return list.some((e) => {
    const start = Date.parse(e.start)
    const end = Date.parse(e.end)
    if (!(start <= now && now < end)) return false
    if (end - start > LONGEST_MEETING_MS) return false
    return e.attendees.length > 1
  })
}

function busy(): boolean {
  const live = getLive()
  if (live && (live.state === 'recording' || live.state === 'paused')) return true
  try {
    if (music().getState().held) return true
  } catch {
    // No player: nothing it could tell us.
  }
  const now = Date.now()
  if (breakSettings().settings.on) refreshCalendar(now)
  return inMeeting(events, now)
}

/** Two soft notes, quiet, rising: the break is over (B7). */
export function playChime(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const t = ctx.currentTime
    for (const [i, freq] of [523.25, 783.99].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const at = t + i * 0.22
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.08, at + 0.04)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.4)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 1.5)
    }
    setTimeout(() => void ctx.close().catch(() => {}), 2000)
  } catch {
    // No sound here: the break still ends.
  }
}

function macHandler(): { postMessage(message: unknown): unknown } | null {
  return (
    (
      window as {
        webkit?: { messageHandlers?: Record<string, { postMessage(m: unknown): unknown }> }
      }
    ).webkit?.messageHandlers?.[MAC_BREAKS_HANDLER] ?? null
  )
}

function channel() {
  if (typeof BroadcastChannel === 'undefined') return null
  const c = new BroadcastChannel('hotsauce-breaks')
  return {
    post: (m: unknown) => c.postMessage(m),
    listen(fn: (m: unknown) => void) {
      const on = (e: MessageEvent) => fn(e.data)
      c.addEventListener('message', on)
      return () => c.removeEventListener('message', on)
    },
  }
}

let runner: BreakRunner | null = null

export function breaks(): BreakRunner {
  runner ??= createBreakRunner({
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    storage: (() => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    })(),
    lock:
      typeof navigator !== 'undefined' && navigator.locks
        ? (run) => {
            void navigator.locks.request(BREAKS_LOCK, run).catch(() => {})
          }
        : null,
    busy,
    settings: () => breakSettings().settings,
    subscribeSettings: subscribeBreakSettings,
    mac: macHandler(),
    chime: playChime,
    notifyHidden(settings) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        new Notification('Time for a screen break', {
          body: `Look at something far away for ${lengthLabel(settings.lengthSeconds)}.`,
          tag: 'hotsauce-break',
          silent: true,
        })
      } catch {
        // Notifications not offered here.
      }
    },
    hidden: () => document.visibilityState === 'hidden',
    channel: channel(),
  })
  return runner
}

/** For tests: a fresh runner next time. */
export function resetBreaksForTests(): void {
  runner = null
  events = []
  calendarFetchedAt = 0
}
