import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ADMIN = { 'x-hearth-dev-user': 'ada@example.org', 'content-type': 'application/json' }
let root: string | undefined
let services: Services | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  services?.index.close()
  services = undefined
  if (root) await removeDir(root)
  root = undefined
})

async function admin() {
  // CI runs a Forgejo service and sets these; the environment would win over the saved values.
  for (const name of ['FORGEJO_URL', 'FORGEJO_ORG', 'FORGEJO_TOKEN']) vi.stubEnv(name, '')
  root = await makeTempDir('hotsauce-wizard-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.org',
    ADMIN_EMAILS: 'ada@example.org',
  })
  services = createServices(config)
  const app = createApp(services)
  return (method: string, url: string, json?: unknown) =>
    app.request(url, { method, headers: ADMIN, ...(json ? { body: JSON.stringify(json) } : {}) })
}

describe('wizard test buttons never send a saved secret somewhere new', () => {
  it('Forgejo: the saved token goes only to the saved address', async () => {
    const call = await admin()
    // Saved straight to the store: this test is about the Test button, not the save checks.
    services?.org.saveSettings({
      hostKind: 'forgejo',
      forgejoUrl: 'https://git.acme.test',
      forgejoOrg: 'acme',
    })
    services?.org.saveSecret('FORGEJO_TOKEN', 'saved-token')
    const sent: Array<{ url: string; auth: string | null }> = []
    vi.stubGlobal('fetch', async (i: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(i, init)
      sent.push({ url: req.url, auth: req.headers.get('authorization') })
      return new Response('{}', { status: 200 })
    })
    const elsewhere = await (
      await call('POST', '/api/admin/org/test/forgejo', { url: 'https://evil.test', org: 'acme' })
    ).json()
    expect(elsewhere.ok).toBe(false)
    expect(sent).toEqual([])
    const saved = await (await call('POST', '/api/admin/org/test/forgejo', {})).json()
    expect(saved).toMatchObject({ ok: true })
    expect(sent).toEqual([
      { url: 'https://git.acme.test/api/v1/orgs/acme', auth: 'token saved-token' },
    ])
  })

  it('storage: the saved secret signs only for the saved endpoint', async () => {
    const call = await admin()
    services?.org.saveSettings({
      s3Endpoint: 'https://s3.acme.test',
      r2AccessKeyId: 'k',
      r2Bucket: 'media',
    })
    services?.org.saveSecret('R2_SECRET_ACCESS_KEY', 'saved-secret')
    const hosts: string[] = []
    vi.stubGlobal('fetch', async (i: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(i, init)
      hosts.push(new URL(req.url).host)
      return req.method === 'GET' ? new Response('ok') : new Response(null, { status: 200 })
    })
    const elsewhere = await (
      await call('POST', '/api/admin/org/test/storage', { endpoint: 'https://evil.test' })
    ).json()
    expect(elsewhere.ok).toBe(false)
    expect(hosts).toEqual([])
    const saved = await (await call('POST', '/api/admin/org/test/storage', {})).json()
    expect(saved).toMatchObject({ ok: true })
    expect(new Set(hosts)).toEqual(new Set(['s3.acme.test']))
  })
})
