import { join } from 'node:path'
import { BREAKS_PATH, defaultBreakSettings } from '@hotsauce/format'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// A member's screen-break settings (docs/PLAN-breaks.md B2).

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-breaks-')
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

describe('Screen break settings', () => {
  it('B2: are the defaults until saved, then the saved ones, per member', async () => {
    expect(await (await call('GET', '/api/breaks')).json()).toEqual({
      settings: defaultBreakSettings(),
      saved: false,
    })
    const mine = { ...defaultBreakSettings(), on: true, everyMinutes: 30, animation: 'waves' }
    const put = await call('PUT', '/api/breaks', ALICE, { settings: mine })
    expect(put.status).toBe(200)
    expect(await (await call('GET', '/api/breaks')).json()).toEqual({ settings: mine, saved: true })
    // Bob still has the defaults.
    expect((await (await call('GET', '/api/breaks', BOB)).json()).saved).toBe(false)

    const space = (await services.spaces.visibleSpaces({ email: ALICE } as never)).find(
      (s) => s.kind === 'personal',
    )
    const file = await services.git.readFile(space?.name ?? '', BREAKS_PATH)
    expect(JSON.parse(file.content)).toEqual(mine)
  })

  it('B2: saving the same settings again makes no new commit', async () => {
    const mine = { ...defaultBreakSettings(), on: true }
    await call('PUT', '/api/breaks', ALICE, { settings: mine })
    const commit = vi.spyOn(services.git, 'commit')
    expect((await call('PUT', '/api/breaks', ALICE, { settings: mine })).status).toBe(200)
    expect(commit).not.toHaveBeenCalled()
  })

  it('B2: refuses wrong settings with what was wrong', async () => {
    const res = await call('PUT', '/api/breaks', ALICE, {
      settings: { ...defaultBreakSettings(), everyMinutes: 1 },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('everyMinutes')
  })
})
