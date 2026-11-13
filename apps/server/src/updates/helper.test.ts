import { describe, expect, it } from 'vitest'
import { FakeFly } from './fake-fly.js'
import { HELPER_ROLE } from './fly.js'
import { runHelper } from './helper.js'

const OLD = 'registry.fly.io/acme:deployment-1'
const NEW = 'ghcr.io/hotsauce-suite/hotsauce:0.3.0'

/** A site whose health reports whatever version `serving()` says. */
const site = (serving: () => string | null) =>
  (async () => {
    const v = serving()
    if (v === null) return new Response('down', { status: 502 })
    return Response.json({ ok: true, version: v })
  }) as unknown as typeof fetch

const base = (fly: FakeFly, fetchFn: typeof fetch) => ({
  fly,
  target: NEW,
  targetVersion: '0.3.0',
  previous: OLD,
  publicUrl: 'https://office.example.com',
  timeoutMs: 20_000,
  pollMs: 5_000,
  fetchFn,
  sleep: async () => {},
  log: () => {},
})

describe('runHelper', () => {
  it('waits again when a first pull outlasts Fly’s one-minute wait', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    let waits = 0
    const wait = fly.waitStarted.bind(fly)
    fly.waitStarted = async (id: string) => {
      waits++
      if (waits < 3) throw new Error('Fly GET /wait: 408 timeout')
      return wait(id)
    }
    const result = await runHelper(
      base(
        fly,
        site(() => '0.3.0'),
      ),
    )
    expect(result).toEqual({ ok: true, version: '0.3.0' })
  })

  it('moves the app machines to the new image and stops once health reports it', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    fly.add('helper', OLD, { role: HELPER_ROLE })
    const result = await runHelper(
      base(
        fly,
        site(() => (fly.image('app1') === NEW ? '0.3.0' : '0.2.0')),
      ),
    )
    expect(result).toEqual({ ok: true, version: '0.3.0' })
    expect(fly.image('app1')).toBe(NEW)
    // It never touches itself.
    expect(fly.image('helper')).toBe(OLD)
    expect(fly.machines.find((m) => m.id === 'app1')?.config.services).toEqual([
      { internal_port: 3000 },
    ])
  })

  it('puts the old image back when the new one never turns healthy', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    const result = await runHelper(
      base(
        fly,
        site(() => (fly.image('app1') === NEW ? null : '0.2.0')),
      ),
    )
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ rolledBack: true })
    expect(fly.image('app1')).toBe(OLD)
  })

  it('gives up on time even when each health check is slow to answer', async () => {
    // Sleeps alone would allow 61 checks of up to 10 s each: 15 minutes, past the window after
    // which the new version stops expecting a rollback.
    const fly = new FakeFly()
    fly.add('app1', OLD)
    let clock = 0
    let checks = 0
    const slow = (async () => {
      checks++
      clock += 10_000
      return new Response('down', { status: 502 })
    }) as unknown as typeof fetch
    const result = await runHelper({
      ...base(fly, slow),
      timeoutMs: 60_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
    })
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(checks).toBeLessThanOrEqual(5)
  })

  it('rolls back when the new version starts but reports the wrong version', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    const result = await runHelper(
      base(
        fly,
        site(() => '0.2.0'),
      ),
    )
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(fly.image('app1')).toBe(OLD)
  })

  it('leaves untouched machines alone when Fly refuses the new image', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    fly.refuse.add(NEW)
    const result = await runHelper(
      base(
        fly,
        site(() => '0.2.0'),
      ),
    )
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(fly.calls.filter((c) => c.startsWith('update'))).toEqual([
      `update app1 ${NEW}`,
      `update app1 ${OLD}`,
    ])
    expect(fly.image('app1')).toBe(OLD)
  })
})
