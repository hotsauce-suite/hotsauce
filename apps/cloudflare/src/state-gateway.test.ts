import { describe, expect, it } from 'vitest'
import { alwaysOn, containerEnv } from './container-env.js'
import { handleState, PREFIX, type StateBucket } from './state-gateway.js'

/** An R2 stand-in with a small page size, so listing has to follow cursors. */
function fakeBucket(pageSize = 2): StateBucket & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>()
  return {
    data,
    async get(key) {
      const v = data.get(key)
      return v ? { arrayBuffer: async () => v.slice().buffer } : null
    },
    async put(key, value) {
      data.set(key, new Uint8Array(value))
    },
    async delete(key) {
      data.delete(key)
    },
    async list({ prefix, cursor }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + pageSize)
      const truncated = start + pageSize < keys.length
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(start + pageSize) } : {}),
      }
    },
  }
}

const req = (method: string, path: string, body?: string) =>
  new Request(`http://state.hotsauce${path}`, { method, ...(body !== undefined ? { body } : {}) })

describe('state gateway (R10)', () => {
  it('stores, lists, reads and deletes under state/, following list cursors', async () => {
    const bucket = fakeBucket()
    bucket.data.set('clips/other.mp4', new Uint8Array([1]))
    for (const k of ['org/settings.json', 'org/assets/my logo.svg', 'tokens/tokens.json']) {
      const path = `/o/${k.split('/').map(encodeURIComponent).join('/')}`
      expect((await handleState(req('PUT', path, `v:${k}`), bucket)).status).toBe(204)
    }
    expect(bucket.data.has(`${PREFIX}org/assets/my logo.svg`)).toBe(true)

    const list = await (await handleState(req('GET', '/list'), bucket)).json()
    expect(list).toEqual({
      keys: ['org/assets/my logo.svg', 'org/settings.json', 'tokens/tokens.json'],
    })

    const got = await handleState(req('GET', '/o/org/settings.json'), bucket)
    expect(await got.text()).toBe('v:org/settings.json')
    expect((await handleState(req('GET', '/o/missing.json'), bucket)).status).toBe(404)

    expect((await handleState(req('DELETE', '/o/org/settings.json'), bucket)).status).toBe(204)
    expect((await handleState(req('GET', '/o/org/settings.json'), bucket)).status).toBe(404)
    expect(bucket.data.has('clips/other.mp4')).toBe(true)
  })

  it('refuses keys that would leave state/', async () => {
    const bucket = fakeBucket()
    for (const path of ['/o/../clips/x', '/o/%2E%2E/clips/x', '/o/', '/o/a//b', '/elsewhere']) {
      expect((await handleState(req('PUT', path, 'x'), bucket)).status, path).toBe(404)
    }
    expect(bucket.data.size).toBe(0)
  })
})

describe('container environment', () => {
  it('passes plain variables and secrets, never bindings, and adds the platform and store', () => {
    const env = containerEnv(
      {
        HOTSAUCE_SETUP_TOKEN: 's3tup-password',
        STATE: {},
        HOTSAUCE: {},
        lower: 'x',
        DEEPGRAM_API_KEY: 'k',
      },
      'https://hotsauce.acme.workers.dev',
    )
    expect(env).toEqual({
      HOTSAUCE_SETUP_TOKEN: 's3tup-password',
      DEEPGRAM_API_KEY: 'k',
      HOTSAUCE_PLATFORM: 'cloudflare',
      STATE_URL: 'http://state.hotsauce',
      PUBLIC_URL: 'https://hotsauce.acme.workers.dev',
    })
  })

  it('keeps a PUBLIC_URL an admin set', () => {
    expect(
      containerEnv({ PUBLIC_URL: 'https://office.acme.com' }, 'https://x.workers.dev').PUBLIC_URL,
    ).toBe('https://office.acme.com')
  })

  it('is always on unless HOTSAUCE_SLEEP is true', () => {
    expect(alwaysOn({})).toBe(true)
    expect(alwaysOn({ HOTSAUCE_SLEEP: 'never' })).toBe(true)
    expect(alwaysOn({ HOTSAUCE_SLEEP: 'true' })).toBe(false)
  })
})
