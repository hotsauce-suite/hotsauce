import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type BreakSchedule,
  GRACE_MS,
  SNOOZE_MS,
  type StepInput,
  skip,
  snooze,
  startNow,
  startSchedule,
  step,
  WARN_MS,
} from './schedule'

const S = { everyMinutes: 20, lengthSeconds: 20 }
const MIN = 60_000
const calm = (now: number): StepInput => ({ now, busy: false, idleMs: 0, inHours: true })

/** Steps once a second from `from` to `to` with the input `at` gives, collecting events. */
function run(
  schedule: BreakSchedule,
  from: number,
  to: number,
  at: (now: number) => StepInput = calm,
  settings = S,
) {
  const events: { at: number; event: string }[] = []
  let s = schedule
  for (let now = from; now <= to; now += 1000) {
    const r = step(s, settings, at(now))
    s = r.schedule
    if (r.event) events.push({ at: now, event: r.event })
  }
  return { schedule: s, events }
}

describe('break schedule (PLAN-breaks B3 to B6)', () => {
  it('B3: warns 10 seconds early, breaks at the due time, ends after the length, counts again', () => {
    const { events } = run(startSchedule(S, 0), 0, 40 * MIN + 20_000)
    expect(events).toEqual([
      { at: 20 * MIN - WARN_MS, event: 'warn' },
      { at: 20 * MIN, event: 'start' },
      { at: 20 * MIN + 20_000, event: 'end' },
      { at: 40 * MIN + 20_000 - WARN_MS, event: 'warn' },
      { at: 40 * MIN + 20_000, event: 'start' },
    ])
  })

  it('B3: skip restarts the full count; 5 more minutes moves it 5 minutes; start now breaks now', () => {
    expect(skip(S, 1000)).toEqual({ dueAt: 1000 + 20 * MIN, phase: { kind: 'counting' } })
    expect(snooze(1000)).toEqual({ dueAt: 1000 + SNOOZE_MS, phase: { kind: 'counting' } })
    expect(startNow(S, 1000)).toEqual({ dueAt: 1000, phase: { kind: 'break', endsAt: 21_000 } })
  })

  it('B4: a break due while busy waits until a minute after the busy time ends', () => {
    const busyUntil = 30 * MIN
    const { events } = run(startSchedule(S, 0), 0, 35 * MIN, (now) => ({
      ...calm(now),
      busy: now >= 15 * MIN && now < busyUntil,
    }))
    // The last busy second is busyUntil - 1s.
    expect(events[0]).toEqual({ at: busyUntil - 1000 + GRACE_MS - WARN_MS, event: 'warn' })
  })

  it('B4: busy during the heads-up calls the break off until after it', () => {
    const { events } = run(startSchedule(S, 0), 0, 23 * MIN + 5000, (now) => ({
      ...calm(now),
      busy: now >= 20 * MIN - 5000 && now < 22 * MIN,
    }))
    expect(events.map((e) => e.event)).toEqual(['warn', 'reset', 'warn', 'start'])
    expect(events[2]?.at).toBe(22 * MIN - 1000 + GRACE_MS - WARN_MS)
  })

  it('B5: being away for a break length counts as the break', () => {
    // Away from minute 10 to minute 15: the count restarts at 15.
    const { events } = run(startSchedule(S, 0), 0, 36 * MIN, (now) => ({
      ...calm(now),
      idleMs: now >= 10 * MIN && now < 15 * MIN ? now - 10 * MIN : 0,
    }))
    const warns = events.filter((e) => e.event === 'warn')
    expect(warns[0]?.at).toBe(15 * MIN - 1000 + 20 * MIN - WARN_MS)
  })

  it('B6: outside working hours no break comes, and the count starts when hours begin', () => {
    const { events } = run(startSchedule(S, 0), 0, 70 * MIN, (now) => ({
      ...calm(now),
      inHours: now >= 30 * MIN,
    }))
    expect(events.find((e) => e.event === 'warn')?.at).toBe(30 * MIN - 1000 + 20 * MIN - WARN_MS)
  })

  it('a page that slept past the due time warns first instead of breaking at once', () => {
    const r = step(startSchedule(S, 0), S, calm(60 * MIN))
    expect(r.event).toBe('warn')
    expect(r.schedule.phase).toEqual({ kind: 'warning', startsAt: 60 * MIN + WARN_MS })
  })

  it('property: never breaks while busy or outside hours, and every break lasts its length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.integer({ min: 10, max: 120 }),
        fc.array(fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()), {
          minLength: 10,
          maxLength: 60,
        }),
        (everyMinutes, lengthSeconds, minutes) => {
          const settings = { everyMinutes, lengthSeconds }
          let s = startSchedule(settings, 0)
          let breakStart: number | null = null
          for (let now = 0; now < minutes.length * MIN; now += 1000) {
            const [busy, away, out] = minutes[Math.floor(now / MIN)] ?? [false, false, false]
            const r = step(s, settings, {
              now,
              busy,
              idleMs: away ? lengthSeconds * 1000 : 0,
              inHours: !out,
            })
            s = r.schedule
            if (r.event === 'start') {
              expect(busy || away || out).toBe(false)
              breakStart = now
            }
            if (r.event === 'end' && breakStart !== null) {
              expect(now - breakStart).toBeGreaterThanOrEqual(lengthSeconds * 1000)
              expect(now - breakStart).toBeLessThan(lengthSeconds * 1000 + 1000)
              breakStart = null
            }
            // Never more often than the interval allows (a break can't follow a break at once).
            if (s.phase.kind === 'counting') expect(s.dueAt).toBeGreaterThan(now)
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
