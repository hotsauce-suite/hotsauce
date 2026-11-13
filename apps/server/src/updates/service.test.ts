import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeFly } from './fake-fly.js'
import type { Release } from './releases.js'
import { Updater, type UpdaterOptions } from './service.js'
import { UpdateStore } from './store.js'

const OLD = 'registry.fly.io/acme:deployment-1'
const release = (version: string): Release => ({
  version,
  notes: `What's new in ${version}`,
  url: `https://github.com/hotsauce-suite/hotsauce/releases/tag/v${version}`,
  publishedAt: '2026-11-12T00:00:00Z',
})

function setup({
  latest: latestOver,
  recording,
  ...over
}: Partial<UpdaterOptions> & { latest?: string | null; recording?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hs-updates-'))
  const store = new UpdateStore(dir)
  const fly = new FakeFly()
  fly.add('app1', OLD)
  let clock = new Date('2026-11-12T10:00:00Z')
  const latest = latestOver === undefined ? '0.3.0' : latestOver
  const make = (current: string) =>
    new Updater({
      current,
      store,
      latestRelease: async () => (latest ? release(latest) : null),
      fly,
      flyEnv: { app: 'acme', region: 'iad', imageRef: OLD },
      image: 'ghcr.io/hotsauce-suite/hotsauce',
      publicUrl: 'https://office.example.com',
      busy: () => recording ?? false,
      now: () => clock,
      log: () => {},
      ...over,
    })
  return {
    store,
    fly,
    make,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

describe('Updater', () => {
  it('says an update is out, with its notes', async () => {
    const { make } = setup()
    const u = make('0.2.0')
    await u.check()
    expect(u.status()).toMatchObject({
      current: '0.2.0',
      updateAvailable: true,
      mode: 'fly',
      auto: true,
      latest: { version: '0.3.0', notes: "What's new in 0.3.0" },
    })
  })

  it('is manual off Fly, and asks for a token on Fly without one', () => {
    const { make } = setup()
    expect(make('0.2.0').mode()).toBe('fly')
    const manual = setup({ flyEnv: {} }).make('0.2.0')
    expect(manual.mode()).toBe('manual')
    const noToken = setup({ fly: null }).make('0.2.0')
    expect(noToken.mode()).toBe('fly-needs-token')
  })

  it('starts a helper on the current image that targets the new release', async () => {
    const { make, fly, store } = setup()
    await make('0.2.0').start()
    expect(fly.created).toHaveLength(1)
    const helper = fly.created[0]?.config as {
      image: string
      auto_destroy: boolean
      metadata: Record<string, string>
      env: Record<string, string>
    }
    expect(helper.image).toBe(OLD)
    expect(helper.auto_destroy).toBe(true)
    expect(helper.env.HOTSAUCE_UPDATE_TARGET).toBe('ghcr.io/hotsauce-suite/hotsauce:0.3.0')
    expect(helper.env.HOTSAUCE_UPDATE_PREVIOUS).toBe(OLD)
    // The token comes from the app's Fly secrets, never through the machine's config.
    expect(JSON.stringify(helper)).not.toContain('FLY_API_TOKEN')
    expect(store.get().pending).toMatchObject({ from: '0.2.0', to: '0.3.0' })
    await expect(make('0.2.0').start()).rejects.toThrow(/Already updating/)
  })

  it('clears the update once the new version has outlasted the helper’s checks', async () => {
    const { make, store, advance } = setup()
    await make('0.2.0').start()
    const next = make('0.3.0')
    next.reconcile()
    // Still pending: the helper can put the old version back if the address never answers.
    expect(store.get().pending).not.toBeNull()
    advance(13 * 60_000)
    await next.tick()
    expect(store.get()).toMatchObject({ pending: null, failed: null })
  })

  it('never loops: a rollback after the new version started still counts as a failure', async () => {
    const { make, store, fly } = setup()
    await make('0.2.0').start()
    make('0.3.0').reconcile()
    const back = make('0.2.0')
    back.reconcile()
    expect(store.get()).toMatchObject({ pending: null, failed: { to: '0.3.0' }, skip: ['0.3.0'] })
    await back.tick()
    expect(fly.created).toHaveLength(1)
  })

  it('refuses to update a server whose PUBLIC_URL is localhost', async () => {
    const { make } = setup({ publicUrl: 'http://localhost:3000' })
    await expect(make('0.2.0').start()).rejects.toThrow(/PUBLIC_URL/)
  })

  it('starts one helper when Update is pressed twice at once', async () => {
    const { make, fly } = setup()
    const u = make('0.2.0')
    const results = await Promise.allSettled([u.start(), u.start()])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(fly.created).toHaveLength(1)
  })

  it('leaves automatic updates to an admin when the app runs more than one machine', async () => {
    const { make, fly } = setup()
    fly.add('app2', OLD)
    await make('0.2.0').tick()
    expect(fly.created).toHaveLength(0)
  })

  it('records a rollback, and automatic updates then skip that version', async () => {
    const { make, store, fly } = setup()
    await make('0.2.0').start()
    // Rolled back: the old version starts again.
    const back = make('0.2.0')
    back.reconcile()
    expect(store.get().failed).toMatchObject({ from: '0.2.0', to: '0.3.0' })
    expect(store.get().skip).toEqual(['0.3.0'])
    await back.tick()
    expect(fly.created).toHaveLength(1)
    expect(back.status().failed).toMatchObject({ to: '0.3.0' })
  })

  it('marks an update that never finished as failed on the next pass', async () => {
    const { make, store, advance } = setup()
    const u = make('0.2.0')
    await u.start()
    advance(10 * 60_000)
    await u.tick()
    expect(store.get().pending).not.toBeNull()
    advance(25 * 60_000)
    await u.tick()
    expect(store.get()).toMatchObject({ pending: null, failed: { to: '0.3.0' } })
  })

  it('updates automatically, but not while a meeting is being recorded or when switched off', async () => {
    const busy = setup({ recording: true })
    await busy.make('0.2.0').tick()
    expect(busy.fly.created).toHaveLength(0)

    const off = setup()
    const u = off.make('0.2.0')
    u.setAuto(false)
    await u.tick()
    expect(off.fly.created).toHaveLength(0)

    const on = setup()
    await on.make('0.2.0').tick()
    expect(on.fly.created).toHaveLength(1)
  })

  it('does nothing when already on the newest release or GitHub has no answer', async () => {
    const same = setup({ latest: '0.2.0' })
    await same.make('0.2.0').tick()
    await expect(same.make('0.2.0').start()).rejects.toThrow(/newest/)
    const none = setup({ latest: null })
    await none.make('0.2.0').tick()
    expect(same.fly.created.length + none.fly.created.length).toBe(0)
  })

  it('records a failure when Fly refuses to start the helper', async () => {
    const { make, fly, store } = setup()
    fly.create = async () => {
      throw new Error('Fly POST /machines: 401 unauthorized')
    }
    await expect(make('0.2.0').start()).rejects.toThrow(/401/)
    expect(store.get()).toMatchObject({ pending: null, failed: { to: '0.3.0' } })
  })
})
