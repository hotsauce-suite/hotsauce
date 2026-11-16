import { join } from 'node:path'
import {
  defaultTodayLayout,
  offerForYou,
  offerGettingStarted,
  TODAY_LAYOUT_PATH,
} from '@hotsauce/format'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// The member's Today layout (ARCHITECTURE §16.4, plan L2) and the header's weather (§16.5, H6).

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-today-layout-')
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      ADMIN_EMAILS: ALICE,
    }),
  )
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', ALICE)
  await call('GET', '/api/me', BOB)
})

afterEach(async () => {
  vi.restoreAllMocks()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, url: string, as = ALICE, json?: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: {
      'x-hearth-dev-user': as,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
}

const mine = {
  schema: 1,
  columns: [
    [
      { id: 'starred', kind: 'starred' },
      { id: 'meetings', kind: 'meetings' },
    ],
    [
      { id: 'board', kind: 'board', board: { space: 'team', id: 'b1' } },
      { id: 'radar', kind: 'radar' },
    ],
  ],
}

describe('Today layout', () => {
  it('is the default until saved, then the saved one, per member', async () => {
    const before = await (await call('GET', '/api/today/layout')).json()
    expect(before).toEqual({
      layout: offerGettingStarted(offerForYou(defaultTodayLayout())),
      saved: false,
    })

    const put = await call('PUT', '/api/today/layout', ALICE, { layout: mine })
    expect(put.status).toBe(200)
    const saved = await (await call('GET', '/api/today/layout')).json()
    expect(saved.saved).toBe(true)
    // The unknown tile is dropped.
    expect(saved.layout.columns[1]).toEqual([
      { id: 'board', kind: 'board', board: { space: 'team', id: 'b1' } },
    ])
    expect(saved.layout.columns[0].map((t: { id: string }) => t.id)).toEqual([
      'starred',
      'meetings',
    ])

    const bob = await (await call('GET', '/api/today/layout', BOB)).json()
    expect(bob.saved).toBe(false)
  })

  it('lives in Git in the personal space, and saving it again makes no new commit', async () => {
    await call('PUT', '/api/today/layout', ALICE, { layout: mine })
    const spaces = await services.spaces.visibleSpaces({
      email: ALICE,
      name: 'Alice',
    } as never)
    const personal = spaces.find((s) => s.kind === 'personal')?.name as string
    const file = await services.git.readFile(personal, TODAY_LAYOUT_PATH)
    expect(JSON.parse(file.content).columns[0][0].kind).toBe('starred')
    const head = await services.git.headOid(personal)
    await call('PUT', '/api/today/layout', ALICE, { layout: mine })
    expect(await services.git.headOid(personal)).toBe(head)
  })

  it('F4: Getting started is offered until a layout is saved without it', async () => {
    const kinds = async (as = ALICE) =>
      (await (await call('GET', '/api/today/layout', as)).json()).layout.columns[0].map(
        (t: { kind: string }) => t.kind,
      )
    expect((await kinds())[0]).toBe('start')

    // Saved with the tile (say, after moving another one): it stays.
    const offered = (await (await call('GET', '/api/today/layout')).json()).layout
    await call('PUT', '/api/today/layout', ALICE, { layout: offered })
    expect((await kinds())[0]).toBe('start')

    // Hidden: gone for good.
    offered.columns[0].shift()
    const put = await (await call('PUT', '/api/today/layout', ALICE, { layout: offered })).json()
    expect(put.layout.gettingStarted).toBe('dismissed')
    expect(await kinds()).not.toContain('start')
  })

  it('F4: a layout saved before Getting started existed is offered it once', async () => {
    const spaces = await services.spaces.visibleSpaces({ email: BOB, name: 'Bob' } as never)
    const personal = spaces.find((s) => s.kind === 'personal')?.name as string
    await services.git.commit(personal, {
      changes: [
        {
          path: TODAY_LAYOUT_PATH,
          content: JSON.stringify({ schema: 1, columns: [[{ id: 'tasks', kind: 'tasks' }], []] }),
        },
      ],
      author: { name: 'Bob', email: BOB },
      message: 'An old layout',
    })
    const got = await (await call('GET', '/api/today/layout', BOB)).json()
    expect(got.saved).toBe(true)
    expect(got.layout.columns[0].map((t: { kind: string }) => t.kind)).toEqual([
      'start',
      'for-you',
      'tasks',
    ])
  })

  it('is not offered to a member with nowhere to save it', async () => {
    vi.spyOn(services.spaces, 'visibleSpaces').mockResolvedValue([])
    const got = await (await call('GET', '/api/today/layout')).json()
    // Getting started is not; For you still is, since it needs nothing saved.
    expect(got).toEqual({ layout: offerForYou(defaultTodayLayout()), saved: false })
  })

  it('refuses something that is not a layout', async () => {
    const res = await call('PUT', '/api/today/layout', ALICE, { layout: { columns: 'no' } })
    expect(res.status).toBe(400)
  })
})

describe('Today weather', () => {
  it('answers from MET Norway, and 502 when MET is down', async () => {
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).startsWith('https://api.met.no/')) return real(input, init)
      return Response.json({
        properties: {
          timeseries: [
            {
              time: new Date().toISOString(),
              data: {
                instant: { details: { air_temperature: 4.2 } },
                next_1_hours: { summary: { symbol_code: 'rain' } },
              },
            },
          ],
        },
      })
    })
    const res = await call('GET', '/api/today/weather?lat=44.4759&lon=-73.2121')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      temperature: 4.2,
      symbol: 'rain',
      credit: 'MET Norway',
    })
    expect(String(spy.mock.calls.at(-1)?.[0])).toContain('lat=44.48&lon=-73.21')

    spy.mockImplementation(async () => new Response('down', { status: 503 }))
    const down = await call('GET', '/api/today/weather?lat=10&lon=10')
    expect(down.status).toBe(502)
    expect((await call('GET', '/api/today/weather?lat=200&lon=0')).status).toBe(400)
  })
})

describe('Today weather places (W5–W7)', () => {
  const MET = {
    properties: {
      timeseries: [
        {
          time: new Date().toISOString(),
          data: {
            instant: { details: { air_temperature: -1.5 } },
            next_1_hours: { summary: { symbol_code: 'snow' } },
          },
        },
      ],
    },
  }
  const BURLINGTON = {
    name: 'Burlington',
    detail: 'Vermont, United States',
    lat: 44.48,
    lon: -73.21,
  }

  function stubOutside() {
    const real = globalThis.fetch
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith('https://api.met.no/')) return Response.json(MET)
      if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
        return Response.json({
          results: [
            {
              name: 'Burlington',
              latitude: 44.4759,
              longitude: -73.2121,
              admin1: 'Vermont',
              country: 'United States',
            },
          ],
        })
      }
      return real(input, init)
    })
  }

  it('searches places by name', async () => {
    const spy = stubOutside()
    const res = await call('GET', '/api/today/places?q=Burlington', BOB)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ places: [BURLINGTON] })
    const asked = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('open-meteo'))
    expect(asked).toContain('name=Burlington')
  })

  it('answers null with no position and no team default', async () => {
    stubOutside()
    const res = await call('GET', '/api/today/weather', BOB)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
    expect((await call('GET', '/api/today/weather?lat=10', BOB)).status).toBe(400)
  })

  it('lets only an admin set the team default, which members then get', async () => {
    const spy = stubOutside()
    const refused = await call('PUT', '/api/today/default-place', BOB, { place: BURLINGTON })
    expect(refused.status).toBe(403)

    const put = await call('PUT', '/api/today/default-place', ALICE, { place: BURLINGTON })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ place: BURLINGTON })
    expect(await (await call('GET', '/api/today/default-place', BOB)).json()).toEqual({
      place: BURLINGTON,
    })

    const weather = await (await call('GET', '/api/today/weather', BOB)).json()
    expect(weather).toMatchObject({ temperature: -1.5, symbol: 'snow', place: 'Burlington' })
    const met = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('api.met.no'))
    expect(met).toContain('lat=44.48&lon=-73.21')

    const cleared = await call('PUT', '/api/today/default-place', ALICE, { place: null })
    expect(await cleared.json()).toEqual({ place: null })
    expect(await (await call('GET', '/api/today/weather', BOB)).json()).toBeNull()
  })
})

// The doc Getting started opens for its last step (docs/PLAN-getting-started.md H1).
describe('the team’s start-here doc', () => {
  const put = (as: string, link: string | null) =>
    call('PUT', '/api/today/start-here', as, { link })
  const get = async (as = BOB) =>
    (await (await call('GET', '/api/today/start-here', as)).json()).doc
  const write = (path: string, content: string | null) =>
    services.git.commit('team', {
      changes: [{ path, content }],
      author: { name: 'Alice', email: ALICE },
      message: 'test',
    })

  it('H1: is nothing until an admin picks one; only an admin can', async () => {
    await write('guides/Start here.md', '# Welcome to the team\n\nRead this first.\n')
    expect(await get()).toBeNull()
    expect((await put(BOB, '/docs/team/guides/Start%20here.md')).status).toBe(403)
    expect(await get()).toBeNull()
  })

  it('H1: takes a pasted link or address, and members get the doc with its title', async () => {
    await write('guides/Start here.md', '# Welcome to the team\n\nRead this first.\n')
    const saved = await put(ALICE, 'https://hotsauce.example.test/docs/team/guides/Start%20here.md')
    expect(saved.status).toBe(200)
    const doc = { path: 'guides/Start here.md', title: 'Welcome to the team' }
    expect(await saved.json()).toEqual({ doc })
    expect(await get()).toEqual(doc)
    // The bare address works too.
    expect((await put(ALICE, '/docs/team/guides/Start%20here.md')).status).toBe(200)
    // Cleared.
    expect(await (await put(ALICE, null)).json()).toEqual({ doc: null })
    expect(await get()).toBeNull()
  })

  it('H1: refuses what isn’t a doc in the Team space, and keeps what was picked', async () => {
    await write('guides/Start here.md', '# Welcome\n')
    await put(ALICE, '/docs/team/guides/Start%20here.md')
    for (const link of [
      '/docs/team/guides/Missing.md',
      '/docs/alice/notes.md',
      '/tasks/team',
      '/docs/team/../team/guides/Start%20here.md/..',
      '/docs/team/guides/picture.png',
      'not a link',
      '/docs/team/guides%2F..%2F..%2Fx.md',
      '/docs/team/%E0%A4%A.md',
      `/docs/team/${'a'.repeat(600)}.md`,
    ]) {
      const res = await put(ALICE, link)
      expect(res.status, link).toBe(400)
    }
    expect((await get())?.path).toBe('guides/Start here.md')
  })

  it('H1: a picked doc that has since been deleted reads as none', async () => {
    await write('guides/Start here.md', '# Welcome\n')
    await put(ALICE, '/docs/team/guides/Start%20here.md')
    await write('guides/Start here.md', null)
    expect(await get()).toBeNull()
  })
})
