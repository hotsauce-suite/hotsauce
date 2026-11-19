import { type BreakSettings, defaultBreakSettings } from '@hotsauce/format'
import { describe, expect, it, vi } from 'vitest'
import {
  AWAY_GAP_MS,
  BUSY_BEAT_MS,
  createBreakRunner,
  type RunnerDeps,
  SCHEDULE_KEY,
} from './runner'
import { SNOOZE_MS, WARN_MS } from './schedule'

const MIN = 60_000

function harness(over: Partial<RunnerDeps> = {}, settings: Partial<BreakSettings> = {}) {
  let now = 0
  let tickFn: (() => void) | null = null
  const store = new Map<string, string>()
  let current: BreakSettings = { ...defaultBreakSettings(), on: true, ...settings }
  const settingsListeners = new Set<() => void>()
  const deps: RunnerDeps = {
    now: () => now,
    setInterval: (fn) => {
      tickFn = fn
      return 1
    },
    clearInterval: () => {
      tickFn = null
    },
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    lock: null,
    busy: () => false,
    settings: () => current,
    subscribeSettings: (fn) => {
      settingsListeners.add(fn)
      return () => settingsListeners.delete(fn)
    },
    mac: null,
    chime: vi.fn(),
    notifyHidden: vi.fn(),
    hidden: () => false,
    channel: null,
    ...over,
  }
  const runner = createBreakRunner(deps)
  return {
    runner,
    deps,
    store,
    /** Advance the clock, ticking every second. */
    advance(ms: number) {
      const end = now + ms
      while (now < end) {
        now += 1000
        tickFn?.()
      }
    },
    /** The computer sleeps for `ms`: no ticks, then one. */
    sleep(ms: number) {
      now += ms
      tickFn?.()
    },
    setSettings(next: Partial<BreakSettings>) {
      current = { ...current, ...next }
      for (const l of settingsListeners) l()
    },
    get now() {
      return now
    },
  }
}

describe('break runner (PLAN-breaks B3, B7, B8, B11)', () => {
  it('B7: warns, breaks for the length, chimes at the end when the chime is on', () => {
    const h = harness()
    h.runner.start()
    expect(h.runner.getView()).toMatchObject({ leader: true, phase: { kind: 'counting' } })
    h.advance(20 * MIN - WARN_MS)
    expect(h.runner.getView().phase.kind).toBe('warning')
    h.advance(WARN_MS)
    expect(h.runner.getView().phase.kind).toBe('break')
    h.advance(20_000)
    expect(h.runner.getView().phase.kind).toBe('counting')
    expect(h.deps.chime).toHaveBeenCalledTimes(1)
  })

  it('B7: no chime when it is off; a hidden page gets a notification', () => {
    const h = harness({ hidden: () => true }, { chime: false })
    h.runner.start()
    h.advance(20 * MIN + 21_000)
    expect(h.deps.chime).not.toHaveBeenCalled()
    expect(h.deps.notifyHidden).toHaveBeenCalledTimes(1)
  })

  it('B3: skip, snooze and start now', () => {
    const h = harness()
    h.runner.start()
    h.advance(20 * MIN - WARN_MS)
    h.runner.snooze()
    expect(h.runner.getView().phase.kind).toBe('counting')
    h.advance(SNOOZE_MS - WARN_MS)
    expect(h.runner.getView().phase.kind).toBe('warning')
    h.runner.skip()
    h.advance(19 * MIN)
    expect(h.runner.getView().phase.kind).toBe('counting')
    h.runner.startNow()
    expect(h.runner.getView().phase.kind).toBe('break')
  })

  it('B3: changing how often restarts the count; turning off drops any break', () => {
    const h = harness()
    h.runner.start()
    h.advance(15 * MIN)
    h.setSettings({ everyMinutes: 10 })
    h.advance(10 * MIN - WARN_MS - 1000)
    expect(h.runner.getView().phase.kind).toBe('counting')
    h.advance(1000)
    expect(h.runner.getView().phase.kind).toBe('warning')
    h.setSettings({ on: false })
    expect(h.runner.getView().phase.kind).toBe('counting')
    h.advance(60 * MIN)
    expect(h.runner.getView().phase.kind).toBe('counting')
  })

  it('B5: a computer that slept for longer than a break restarts the count', () => {
    const h = harness()
    h.runner.start()
    h.advance(15 * MIN)
    h.sleep(AWAY_GAP_MS + 1000)
    const woke = h.now
    expect(JSON.parse(h.store.get(SCHEDULE_KEY) ?? '{}').dueAt).toBe(woke + 20 * MIN)
    // A short nap doesn't.
    h.sleep(10_000)
    expect(JSON.parse(h.store.get(SCHEDULE_KEY) ?? '{}').dueAt).toBe(woke + 20 * MIN)
  })

  it('B5: a hidden tab whose timer runs once a minute still takes its break', () => {
    const h = harness()
    h.runner.start()
    let warned = false
    for (let i = 0; i < 21; i++) {
      h.sleep(MIN - 1000)
      if (h.runner.getView().phase.kind !== 'counting') warned = true
    }
    expect(warned).toBe(true)
  })

  it('B3: turning breaks off and on again starts a fresh count', () => {
    const h = harness()
    h.runner.start()
    h.advance(15 * MIN)
    h.setSettings({ on: false })
    h.advance(1000)
    expect(h.store.has(SCHEDULE_KEY)).toBe(false)
    h.setSettings({ on: true })
    h.advance(1000)
    expect(JSON.parse(h.store.get(SCHEDULE_KEY) ?? '{}').dueAt).toBe(h.now - 1000 + 20 * MIN)
  })

  it('B8: stopping lets go of the lock, and a lock granted after stopping is handed straight on', async () => {
    const runs: Promise<void>[] = []
    const h = harness({ lock: (run) => void runs.push(run()) })
    const stop = h.runner.start()
    expect(h.runner.getView().leader).toBe(true)
    let released = false
    void runs[0]?.then(() => {
      released = true
    })
    stop()
    await Promise.resolve()
    expect(released).toBe(true)
    expect(h.runner.getView().leader).toBe(false)

    // Granted late, after the run that asked for it ended.
    let grant: (() => Promise<void>) | null = null
    const late = harness({
      lock: (run) => {
        grant = run
      },
    })
    late.runner.start()()
    await expect((grant as unknown as () => Promise<void>)()).resolves.toBeUndefined()
    expect(late.runner.getView().leader).toBe(false)
  })

  it('B8: a new leader carries on with the count kept in this browser', () => {
    const a = harness()
    a.runner.start()
    a.advance(5 * MIN)
    expect(JSON.parse(a.store.get(SCHEDULE_KEY) ?? '{}').dueAt).toBe(20 * MIN)
    // Another tab takes over with a count due in 5 minutes: it keeps it, not a fresh 20.
    const kept = JSON.stringify({ dueAt: 5 * MIN, phase: { kind: 'counting' } })
    const b = harness({ storage: { getItem: () => kept, setItem: () => {}, removeItem: () => {} } })
    b.runner.start()
    b.advance(5 * MIN - WARN_MS)
    expect(b.runner.getView().phase.kind).toBe('warning')
  })

  it("B8: a tab that is not the leader shows the leader's break and asks it to skip", () => {
    const post = vi.fn()
    let send: ((m: unknown) => void) | null = null
    const h = harness({
      lock: () => {},
      channel: {
        post,
        listen: (fn) => {
          send = fn
          return () => {}
        },
      },
    })
    h.runner.start()
    const deliver = send as unknown as (m: unknown) => void
    deliver({ type: 'schedule', schedule: { dueAt: 0, phase: { kind: 'break', endsAt: 20_000 } } })
    expect(h.runner.getView()).toMatchObject({ leader: false, phase: { kind: 'break' } })
    h.runner.skip()
    expect(post).toHaveBeenCalledWith('skip')
    expect(h.runner.getView().phase.kind).toBe('counting')
  })

  it('B8: a tab that is not the leader shows nothing on its own and asks the leader to start a break', () => {
    const post = vi.fn()
    const h = harness({
      lock: () => {}, // never granted
      channel: { post, listen: () => () => {} },
    })
    h.runner.start()
    h.advance(30 * MIN)
    expect(h.runner.getView()).toMatchObject({ leader: false, phase: { kind: 'counting' } })
    h.runner.startNow()
    expect(post).toHaveBeenCalledWith('startNow')
  })

  it('B11: inside the Mac app it posts settings and recording state, and keeps no timer', () => {
    const postMessage = vi.fn()
    let busy = false
    const h = harness({ mac: { postMessage }, busy: () => busy })
    h.runner.start()
    expect(postMessage).toHaveBeenCalledWith({ type: 'settings', settings: h.deps.settings() })
    expect(postMessage).toHaveBeenCalledWith({ type: 'busy', busy: false })
    busy = true
    h.advance(1000)
    expect(postMessage).toHaveBeenCalledWith({ type: 'busy', busy: true })
    // Said again while it lasts, so the app can forget a page that closed mid-recording.
    postMessage.mockClear()
    h.advance(BUSY_BEAT_MS)
    expect(postMessage).toHaveBeenCalledWith({ type: 'busy', busy: true })
    busy = false
    h.setSettings({ everyMinutes: 30 })
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'settings',
      settings: expect.objectContaining({ everyMinutes: 30 }),
    })
    h.advance(40 * MIN)
    expect(h.runner.getView().phase.kind).toBe('counting')
    h.runner.startNow()
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'startNow' })
  })
})
