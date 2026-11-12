import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@acme.example'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-desktop-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'acme.example',
  })
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  await removeDir(root)
})

function post(path: string, headers: Record<string, string> = {}, json?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { ...headers, ...(json ? { 'content-type': 'application/json' } : {}) },
    ...(json ? { body: JSON.stringify(json) } : {}),
  })
}

describe('POST /api/desktop/ticket', () => {
  it('gives a signed-in member a one-time ticket for their own account, never cached', async () => {
    const res = await post('/api/desktop/ticket', { 'x-hearth-dev-user': ALICE })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Dev sign-in's ticket is the member's own dev user id.
    expect(await res.json()).toEqual({ ticket: `dev:${ALICE}` })
  })

  it('refuses without a session', async () => {
    expect((await post('/api/desktop/ticket')).status).toBe(401)
  })

  it('refuses outsiders (the domain lock)', async () => {
    const res = await post('/api/desktop/ticket', { 'x-hearth-dev-user': 'eve@example.com' })
    expect(res.status).toBe(403)
  })

  it('refuses an access token: a token must not become a full session', async () => {
    const made = await post('/api/tokens', { 'x-hearth-dev-user': ALICE }, { name: 'agent' })
    const { token } = (await made.json()) as { token: string }
    const res = await post('/api/desktop/ticket', { authorization: `Bearer ${token}` })
    expect(res.status).toBe(403)
  })

  it('refuses a Dictate device token', async () => {
    const made = await post(
      '/api/dictation/devices',
      { 'x-hearth-dev-user': ALICE },
      { name: 'Mac' },
    )
    const { token } = (await made.json()) as { token: string }
    const res = await post('/api/desktop/ticket', { authorization: `Bearer ${token}` })
    expect([401, 403]).toContain(res.status)
  })
})
