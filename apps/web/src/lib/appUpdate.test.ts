import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import {
  BUILD_VERSION,
  fetchNewWorker,
  RELOAD_KEY,
  RETRY_AFTER_MS,
  takeUpdatedVersion,
  UpdateWatch,
  type UpdateWatchDeps,
} from './appUpdate'

function memoryStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  }
}

function setup(over: Partial<UpdateWatchDeps> = {}) {
  let clock = 1_000_000
  const storage = memoryStore()
  const deps: UpdateWatchDeps = {
    buildVersion: '0.44.0',
    serverVersion: vi.fn(async () => '0.45.0'),
    blocker: vi.fn(() => null),
    prepare: vi.fn(async () => {}),
    reload: vi.fn(),
    storage,
    now: () => clock,
    ...over,
  }
  return {
    deps,
    storage,
    watch: new UpdateWatch(deps),
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('build version (R1)', () => {
  it('is empty outside a production build, so tests and the dev server never reload', () => {
    expect(BUILD_VERSION).toBe('')
  })

  it('does nothing without a build version', async () => {
    const { watch, deps } = setup({ buildVersion: '' })
    await watch.check()
    expect(deps.serverVersion).not.toHaveBeenCalled()
    expect(await watch.moment('hidden')).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })
})

describe('noticing a new release (R2)', () => {
  it('marks a different server release as waiting', async () => {
    const { watch } = setup()
    await watch.check()
    expect(watch.waiting).toBe('0.45.0')
  })

  it('treats a rollback as an update too', async () => {
    const { watch } = setup({ serverVersion: async () => '0.43.1' })
    await watch.check()
    expect(watch.waiting).toBe('0.43.1')
  })

  it('waits for nothing when the server runs this build', async () => {
    const { watch, deps } = setup({ serverVersion: async () => '0.44.0' })
    await watch.check()
    expect(watch.waiting).toBeNull()
    expect(await watch.moment('idle')).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('ignores a server it cannot reach', async () => {
    const { watch } = setup({
      serverVersion: async () => {
        throw new TypeError('offline')
      },
    })
    await watch.check()
    expect(watch.waiting).toBeNull()
  })
})

describe('reloading at a safe moment (R3, R4, R5)', () => {
  it('reloads at a moment once the build is fetched', async () => {
    const order: string[] = []
    const { watch } = setup({
      prepare: async () => void order.push('prepare'),
      reload: () => void order.push('reload'),
    })
    await watch.check()
    expect(await watch.moment('navigate')).toBe(true)
    expect(order).toEqual(['prepare', 'reload'])
  })

  it('never reloads while something would be lost, and tries again later', async () => {
    let blocked: string | null = 'meeting'
    const { watch, deps } = setup({ blocker: () => blocked })
    await watch.check()
    expect(await watch.moment('hidden')).toBe(false)
    expect(deps.prepare).not.toHaveBeenCalled()
    blocked = null
    expect(await watch.moment('hidden')).toBe(true)
  })

  it('holds off when someone starts typing while the build downloads', async () => {
    let calls = 0
    const { watch, deps } = setup({ blocker: () => (calls++ === 0 ? null : 'typing') })
    await watch.check()
    expect(await watch.moment('idle')).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('still reloads when fetching the build fails', async () => {
    const { watch, deps } = setup({ prepare: () => Promise.reject(new Error('no worker')) })
    await watch.check()
    expect(await watch.moment('hidden')).toBe(true)
    expect(deps.reload).toHaveBeenCalledOnce()
  })

  it('property: a blocked page is never reloaded, whatever the moments', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('hidden', 'idle', 'navigate') as fc.Arbitrary<'hidden'>, {
          maxLength: 20,
        }),
        fc.constantFrom('meeting', 'guarded', 'typing', 'dialog'),
        async (moments, reason) => {
          const { watch, deps } = setup({ blocker: () => reason })
          await watch.check()
          for (const m of moments) await watch.moment(m)
          expect(deps.reload).not.toHaveBeenCalled()
        },
      ),
    )
  })
})

describe('no reload loops (R6)', () => {
  it('reloads once per release every 30 minutes', async () => {
    const first = setup()
    await first.watch.check()
    expect(await first.watch.moment('hidden')).toBe(true)

    // The page came back still on the old build (the new one couldn't be fetched).
    const again = new UpdateWatch({ ...first.deps, reload: vi.fn() })
    await again.check()
    expect(await again.moment('hidden')).toBe(false)
    first.tick(RETRY_AFTER_MS)
    expect(await again.moment('hidden')).toBe(true)
  })

  it('never reloads without storage to note the attempt in', async () => {
    const { watch, deps } = setup({ storage: null })
    await watch.check()
    expect(await watch.moment('hidden')).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('a newer release than the one tried reloads at once', async () => {
    const first = setup()
    await first.watch.check()
    await first.watch.moment('hidden')
    const next = new UpdateWatch({
      ...first.deps,
      serverVersion: async () => '0.46.0',
      reload: vi.fn(),
    })
    await next.check()
    expect(await next.moment('hidden')).toBe(true)
  })
})

describe('saying it updated (R7)', () => {
  it('names the release once after a reload brought it', () => {
    const storage = memoryStore()
    storage.setItem(RELOAD_KEY, JSON.stringify({ version: '0.45.0', at: 1 }))
    expect(takeUpdatedVersion('0.45.0', storage)).toBe('0.45.0')
    expect(takeUpdatedVersion('0.45.0', storage)).toBeNull()
  })

  it('says nothing when the reload left the old build running', () => {
    const storage = memoryStore()
    storage.setItem(RELOAD_KEY, JSON.stringify({ version: '0.45.0', at: 1 }))
    expect(takeUpdatedVersion('0.44.0', storage)).toBeNull()
    // Kept, so the loop guard still sees it.
    expect(storage.map.has(RELOAD_KEY)).toBe(true)
  })

  it('shrugs off a garbled note', () => {
    const storage = memoryStore()
    storage.setItem(RELOAD_KEY, '{nope')
    expect(takeUpdatedVersion('0.45.0', storage)).toBeNull()
  })
})

describe('fetchNewWorker (R5)', () => {
  function fakeContainer(opts: { finds: boolean }) {
    const listeners: Array<() => void> = []
    const reg = {
      installing: null as object | null,
      waiting: null,
      update: vi.fn(async () => {
        if (opts.finds) {
          reg.installing = {}
          setTimeout(() => {
            for (const l of listeners) l()
          }, 10)
        }
      }),
    }
    const container = {
      controller: {},
      getRegistration: async () => reg,
      addEventListener: (_type: string, l: () => void) => void listeners.push(l),
    }
    return { container: container as unknown as ServiceWorkerContainer, reg }
  }

  it('waits for the new worker to take over', async () => {
    const { container, reg } = fakeContainer({ finds: true })
    await fetchNewWorker(container, 5_000)
    expect(reg.update).toHaveBeenCalledOnce()
  })

  it('returns at once when there is no new worker', async () => {
    const { container } = fakeContainer({ finds: false })
    const started = Date.now()
    await fetchNewWorker(container, 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('gives up after the wait', async () => {
    const { container, reg } = fakeContainer({ finds: false })
    reg.update.mockImplementation(async () => {
      reg.installing = {}
    })
    const started = Date.now()
    await fetchNewWorker(container, 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  it('does nothing without a service worker', async () => {
    await expect(fetchNewWorker(undefined)).resolves.toBeUndefined()
  })
})
