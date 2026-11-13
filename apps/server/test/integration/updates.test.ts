import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type ServiceOverrides, type Services } from '../../src/services.js'
import { FakeFly } from '../../src/updates/fake-fly.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Settings → Organization → Updates (docs/PLAN-releases-and-updates.md, R4–R8).
const ADMIN = 'ada@acme.example'
const MEMBER = 'grace@acme.example'
const OLD = 'registry.fly.io/acme:deployment-1'

let root: string | undefined
let running: Services[] = []

afterEach(async () => {
  for (const s of running) s.index.close()
  running = []
  if (root) await removeDir(root)
  root = undefined
})

async function instance(overrides: ServiceOverrides) {
  root ??= await makeTempDir('hearth-updates-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'acme.example',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://office.example.com',
  })
  const services = createServices(config, {
    version: '0.2.0',
    latestRelease: async () => ({
      version: '0.3.0',
      notes: '- Tables can sort by date',
      url: 'https://github.com/hotsauce-suite/hotsauce/releases/tag/v0.3.0',
      publishedAt: '2026-11-12T00:00:00Z',
    }),
    ...overrides,
  })
  running.push(services)
  await services.spaces.ensureTeamSpace()
  const app = createApp(services)
  return (method: string, path: string, as: string, json?: unknown) =>
    app.request(path, {
      method,
      headers: {
        'x-hearth-dev-user': as,
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    })
}

describe('updates', () => {
  it('shows admins the newest release; members are turned away', async () => {
    const call = await instance({ fly: null, flyEnv: {} })
    const res = await call('GET', '/api/admin/org/updates', ADMIN)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      current: '0.2.0',
      updateAvailable: true,
      mode: 'manual',
      auto: true,
      latest: { version: '0.3.0', notes: '- Tables can sort by date' },
    })
    expect((await call('GET', '/api/admin/org/updates', MEMBER)).status).toBe(403)
    expect((await call('POST', '/api/admin/org/updates/start', MEMBER)).status).toBe(403)
  })

  it('keeps the automatic-updates switch across restarts', async () => {
    const call = await instance({ fly: null, flyEnv: {} })
    const off = await call('PUT', '/api/admin/org/updates/auto', ADMIN, { on: false })
    expect((await off.json()).auto).toBe(false)
    expect((await call('PUT', '/api/admin/org/updates/auto', ADMIN, { on: 'no' })).status).toBe(400)
    const again = await instance({ fly: null, flyEnv: {} })
    expect((await (await again('GET', '/api/admin/org/updates', ADMIN)).json()).auto).toBe(false)
  })

  it('refuses Update where the server can’t update itself', async () => {
    const call = await instance({ fly: null, flyEnv: {} })
    const res = await call('POST', '/api/admin/org/updates/start', ADMIN)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toMatch(/steps for your host/)
  })

  it('on Fly, Update starts the helper machine and shows the update in progress', async () => {
    const fly = new FakeFly()
    fly.add('app1', OLD)
    const call = await instance({ fly, flyEnv: { app: 'acme', region: 'iad', imageRef: OLD } })
    const res = await call('POST', '/api/admin/org/updates/start', ADMIN)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      mode: 'fly',
      updating: { from: '0.2.0', to: '0.3.0' },
    })
    expect(fly.created).toHaveLength(1)
    expect((await call('POST', '/api/admin/org/updates/start', ADMIN)).status).toBe(409)
  })
})
