import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { HearthError } from '../../src/errors.js'
import { OrgStore } from '../../src/org/store.js'
import { testProvider } from '../../src/org/test-keys.js'
import { UnconfiguredLLM } from '../../src/org/unconfigured.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ADMIN = 'ada@example.org'
const MEMBER = 'max@example.org'
const SK = 'sk_test_abcdefghijklmnopqrstuvwxyz1234'

let root: string
let services: Services | undefined

afterEach(async () => {
  services?.index.close()
  services = undefined
  if (root) await removeDir(root)
})

/** A fresh instance, the way main.ts builds one: saved org settings under the given env. */
async function instance(env: Record<string, string> = {}) {
  root ??= ''
  root = await makeTempDir('hotsauce-org-')
  const dataDir = join(root, 'data')
  const base = {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    LOCAL_HOST_DIR: join(root, 'remotes'),
    HOTSAUCE_MASTER_KEY: 'test-master-key',
    ...env,
  }
  const org = new OrgStore({ dataDir, masterKey: 'test-master-key', env: base })
  const config = loadConfig({
    ...org.toEnv(),
    HOTSAUCE_SETUP_PENDING: org.settings().setupComplete ? 'false' : 'true',
    ...base,
  })
  services = createServices(config, { org })
  await services.spaces.ensureTeamSpace()
  const restart = vi.fn()
  const app = createApp({ ...services, restart })
  const call = (
    method: string,
    url: string,
    opts: { json?: unknown; headers?: Record<string, string>; body?: BodyInit } = {},
  ) => {
    const headers: Record<string, string> = { ...opts.headers }
    let body = opts.body
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    return app.request(url, { method, headers, ...(body !== undefined ? { body } : {}) })
  }
  return { app, call, org, config, restart, dataDir, base }
}

describe('setup mode', () => {
  it('starts in setup mode with no sign-in keys, and only the wizard answers', async () => {
    const { call, config } = await instance({ AUTH_MODE: 'clerk' })
    expect(config.AUTH_MODE).toBe('setup')
    const health = await (await call('GET', '/api/health')).json()
    expect(health).toMatchObject({ ok: true, setupRequired: true, productName: 'Hotsauce' })
    // Everything else needs a session nobody can have yet.
    expect((await call('GET', '/api/spaces')).status).toBe(401)
  })

  it('refuses the wizard without the setup token, and with a wrong one', async () => {
    const { call, org } = await instance({ AUTH_MODE: 'clerk' })
    expect((await call('GET', '/api/setup/state')).status).toBe(401)
    expect(
      (await call('GET', '/api/setup/state', { headers: { 'x-setup-token': 'nope' } })).status,
    ).toBe(401)
    const ok = await call('GET', '/api/setup/state', {
      headers: { 'x-setup-token': org.setupToken() },
    })
    expect(ok.status).toBe(200)
  })

  it('saves settings and keys, never returns a key, and stores keys encrypted', async () => {
    const { call, org, dataDir } = await instance({ AUTH_MODE: 'clerk' })
    const headers = { 'x-setup-token': org.setupToken() }
    const res = await call('PUT', '/api/setup/settings', {
      headers,
      json: {
        orgName: 'Acme',
        productName: 'Acme Office',
        allowedDomains: 'example.org, @Example.com',
        adminEmails: [ADMIN],
        secrets: { ANTHROPIC_API_KEY: 'sk-ant-secretvalue-9876', CLERK_SECRET_KEY: SK },
      },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('secretvalue')
    expect(text).not.toContain(SK)
    const state = JSON.parse(text)
    expect(state.settings.allowedDomains).toEqual(['example.org', 'example.com'])
    expect(state.secrets.ANTHROPIC_API_KEY).toEqual({ set: true, last4: '9876', source: 'saved' })
    const onDisk = readFileSync(join(dataDir, 'org', 'secrets.json'), 'utf8')
    expect(onDisk).not.toContain('secretvalue')
    expect(org.savedSecret('ANTHROPIC_API_KEY')).toBe('sk-ant-secretvalue-9876')
    // The same file can't be read with another master key.
    expect(
      new OrgStore({ dataDir, masterKey: 'other' }).savedSecret('ANTHROPIC_API_KEY'),
    ).toBeNull()
  })

  it('rejects bad domains, emails and publishable keys with a readable message', async () => {
    const { call, org } = await instance({ AUTH_MODE: 'clerk' })
    const headers = { 'x-setup-token': org.setupToken() }
    for (const json of [
      { allowedDomains: 'not a domain' },
      { adminEmails: 'nobody' },
      { clerkPublishableKey: 'sk_test_oops' },
      { unknownField: 1 },
    ]) {
      const res = await call('PUT', '/api/setup/settings', { headers, json })
      expect(res.status, JSON.stringify(json)).toBe(400)
    }
  })

  it('says what is missing, then finishes, restarts and starts signed-in mode with the saved settings', async () => {
    const first = await instance({ AUTH_MODE: 'clerk' })
    const headers = { 'x-setup-token': first.org.setupToken() }
    const early = await first.call('POST', '/api/setup/finish', { headers })
    expect(early.status).toBe(400)
    const body = await early.json()
    expect(body.error.details.missing).toEqual(
      expect.arrayContaining(['Your organization’s name', 'Clerk secret key']),
    )

    await first.call('PUT', '/api/setup/settings', {
      headers,
      json: {
        orgName: 'Acme',
        productName: 'Acme Office',
        allowedDomains: 'example.org',
        adminEmails: 'ada@other.net',
        clerkPublishableKey: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
        secrets: { CLERK_SECRET_KEY: SK },
      },
    })
    // An admin outside the allowed domains could never sign in.
    const outsider = await first.call('POST', '/api/setup/finish', { headers })
    expect(outsider.status).toBe(400)
    expect((await outsider.json()).error.message).toContain('ada@other.net')

    await first.call('PUT', '/api/setup/settings', { headers, json: { adminEmails: ADMIN } })
    vi.useFakeTimers()
    try {
      const done = await first.call('POST', '/api/setup/finish', { headers })
      expect(done.status).toBe(200)
      vi.advanceTimersByTime(1000)
      expect(first.restart).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }

    // After the restart: the saved settings are the config, and setup is closed.
    const env = first.org.toEnv()
    expect(env).toMatchObject({
      ORG_NAME: 'Acme',
      PRODUCT_NAME: 'Acme Office',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
      CLERK_SECRET_KEY: SK,
    })
    const config = loadConfig({
      ...env,
      HOTSAUCE_SETUP_PENDING: 'false',
      ...first.base,
      AUTH_MODE: 'clerk',
    })
    expect(config.AUTH_MODE).toBe('clerk')
    expect(config.PRODUCT_NAME).toBe('Acme Office')
    // The setup link is spent: even this process, still in setup mode, refuses it now.
    const again = await first.call('GET', '/api/setup/state', { headers })
    expect(again.status).toBe(401)
  })

  it('adds wizard steps to the saved list, so quick steps never overwrite each other', async () => {
    const { call, org } = await instance({ AUTH_MODE: 'clerk' })
    const headers = { 'x-setup-token': org.setupToken() }
    await Promise.all([
      call('PUT', '/api/setup/settings', { headers, json: { addStepDone: 'org' } }),
      call('PUT', '/api/setup/settings', { headers, json: { addStepDone: 'brand' } }),
    ])
    await call('PUT', '/api/setup/settings', { headers, json: { addStepDone: 'org' } })
    expect([...org.settings().stepsDone].sort()).toEqual(['brand', 'org'])
  })

  it('never lets saved settings beat the environment', async () => {
    const { org } = await instance({ AUTH_MODE: 'clerk' })
    org.saveSettings({ orgName: 'Saved', productName: 'Saved', setupComplete: true })
    const config = loadConfig({
      ...org.toEnv(),
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      PRODUCT_NAME: 'Hearth',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      DATA_DIR: join(root, 'data'),
    })
    expect(config.PRODUCT_NAME).toBe('Hearth')
    expect(config.ORG_NAME).toBe('Saved')
  })
})

describe('a running instance', () => {
  it('undoes an admin save the server couldn’t start with, so a restart can’t take it down', async () => {
    const { call, org } = await instance({
      AUTH_MODE: 'dev',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
    })
    const admin = { 'x-hearth-dev-user': ADMIN }
    // GitHub without a token: the next start would fail.
    const res = await call('PUT', '/api/admin/org/settings', {
      headers: admin,
      json: { hostKind: 'github', githubOrg: 'acme' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('GITHUB_TOKEN')
    expect(org.settings()).toMatchObject({ hostKind: 'local', githubOrg: '', setupComplete: false })
    expect(org.toEnv()).toEqual({})
  })

  it('opens keys saved before HOTSAUCE_MASTER_KEY was set, and names keys it can’t open', async () => {
    root = await makeTempDir('hotsauce-org-')
    const dataDir = join(root, 'data')
    new OrgStore({ dataDir, env: {} }).saveSecret('CLERK_SECRET_KEY', SK)
    expect(
      new OrgStore({ dataDir, masterKey: 'set-later', env: {} }).savedSecret('CLERK_SECRET_KEY'),
    ).toBe(SK)
    rmSync(join(dataDir, 'org', 'master.key'))
    const lost = new OrgStore({ dataDir, masterKey: 'set-later', env: {} })
    expect(lost.savedSecret('CLERK_SECRET_KEY')).toBeNull()
    expect(lost.undecryptable()).toEqual(['CLERK_SECRET_KEY'])
  })

  it('refuses the setup wizard once set up, even with the token', async () => {
    const { call, org } = await instance({ AUTH_MODE: 'dev', ALLOWED_EMAIL_DOMAINS: 'example.org' })
    const res = await call('GET', '/api/setup/state', {
      headers: { 'x-setup-token': org.setupToken() },
    })
    expect(res.status).toBe(403)
  })

  it('lets only admins edit the organization, and applying restarts', async () => {
    const { call, restart } = await instance({
      AUTH_MODE: 'dev',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
    })
    const member = await call('GET', '/api/admin/org/state', {
      headers: { 'x-hearth-dev-user': MEMBER },
    })
    expect(member.status).toBe(403)
    const admin = { 'x-hearth-dev-user': ADMIN }
    const state = await (await call('GET', '/api/admin/org/state', { headers: admin })).json()
    expect(state.effective.allowedDomains).toEqual(['example.org'])
    expect(state.setupMode).toBe(false)
    const saved = await call('PUT', '/api/admin/org/settings', {
      headers: admin,
      json: { orgName: 'Acme' },
    })
    expect(saved.status).toBe(200)
    expect((await saved.json()).settings.setupComplete).toBe(true)
    vi.useFakeTimers()
    try {
      expect((await call('POST', '/api/admin/org/apply', { headers: admin })).status).toBe(200)
      vi.advanceTimersByTime(1000)
      expect(restart).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses half an R2 setup, which would quietly store video on the disk', async () => {
    const { call } = await instance({
      AUTH_MODE: 'dev',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
    })
    const admin = { 'x-hearth-dev-user': ADMIN }
    const res = await call('PUT', '/api/admin/org/settings', {
      headers: admin,
      json: { r2AccountId: 'acct', r2AccessKeyId: 'id', r2Bucket: 'videos' },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('All four Cloudflare R2 values')
    const state = await (await call('GET', '/api/admin/org/state', { headers: admin })).json()
    expect(state.settings.r2Bucket).toBe('')
  })

  it('serves the brand kit publicly and validates changes', async () => {
    const { call } = await instance({
      AUTH_MODE: 'dev',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
      PRODUCT_NAME: 'Hearth',
      ORG_NAME: 'Acme',
    })
    const brand = await (await call('GET', '/api/org/brand')).json()
    expect(brand).toMatchObject({
      productName: 'Hearth',
      orgName: 'Acme',
      primary: '#c63d19',
      logoUrl: null,
    })
    const admin = { 'x-hearth-dev-user': ADMIN }
    const bad = await call('PUT', '/api/admin/org/brand', {
      headers: admin,
      json: { primary: 'red' },
    })
    expect(bad.status).toBe(400)
    const good = await call('PUT', '/api/admin/org/brand', {
      headers: admin,
      json: { primary: '#1f3a5f', fonts: 'modern', voice: 'Plain and warm.' },
    })
    expect(good.status).toBe(200)
    const after = await (await call('GET', '/api/org/brand')).json()
    expect(after).toMatchObject({ primary: '#1f3a5f', voice: 'Plain and warm.' })
    expect(after.fonts).toMatchObject({ choice: 'modern', display: 'Space Grotesk' })
  })

  it('stores a logo, serves it with a locked-down CSP, and refuses other file types', async () => {
    const { call } = await instance({
      AUTH_MODE: 'dev',
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      ADMIN_EMAILS: ADMIN,
    })
    const admin = { 'x-hearth-dev-user': ADMIN }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const exe = await call('PUT', '/api/admin/org/assets/logo', {
      headers: { ...admin, 'content-type': 'application/x-msdownload' },
      body: 'MZ',
    })
    expect(exe.status).toBe(400)
    const up = await call('PUT', '/api/admin/org/assets/logo', {
      headers: { ...admin, 'content-type': 'image/svg+xml' },
      body: svg,
    })
    expect(up.status).toBe(200)
    const brand = await (await call('GET', '/api/org/brand')).json()
    expect(brand.logoUrl).toMatch(/^\/api\/org\/assets\/logo\?v=/)
    expect(brand.markUrl).toBe(brand.logoUrl)
    const logo = await call('GET', '/api/org/assets/logo')
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/svg+xml')
    expect(logo.headers.get('content-security-policy')).toContain('sandbox')
    expect(await logo.text()).toBe(svg)
    expect((await call('DELETE', '/api/admin/org/assets/logo', { headers: admin })).status).toBe(
      200,
    )
    expect((await call('GET', '/api/org/assets/logo')).status).toBe(404)
  })
})

describe('bring your own keys', () => {
  it('runs production with no AI keys, and those features say how to turn them on', async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'clerk',
      CLERK_SECRET_KEY: SK,
      ALLOWED_EMAIL_DOMAINS: 'example.org',
      DATA_DIR: '/tmp/unused',
    })
    expect(config.LLM_PROVIDER).toBe('none')
    expect(config.ASR_PROVIDER).toBe('none')
    await expect(new UnconfiguredLLM().complete()).rejects.toMatchObject({
      code: 'not_configured',
      message: expect.stringContaining('Settings → Organization'),
    })
    expect(new HearthError('not_configured', 'x').status).toBe(503)
  })

  it('still refuses fakes in production, and needs sign-in domains', () => {
    const production = {
      NODE_ENV: 'production',
      AUTH_MODE: 'clerk',
      CLERK_SECRET_KEY: SK,
      ALLOWED_EMAIL_DOMAINS: 'example.org',
    }
    expect(() => loadConfig({ ...production, LLM_PROVIDER: 'fake' })).toThrow(/LLM_PROVIDER/)
    expect(() => loadConfig({ ...production, ALLOWED_EMAIL_DOMAINS: '' })).toThrow(
      /ALLOWED_EMAIL_DOMAINS/,
    )
  })

  it('tests a key with one read-only request and reports plainly', async () => {
    const fetchOk = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await testProvider('anthropic', 'k', '', fetchOk as never)).toEqual({
      ok: true,
      message: 'Anthropic accepted the key',
    })
    const call = fetchOk.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toContain('api.anthropic.com/v1/models')
    const fetch401 = vi.fn(async () => new Response('{}', { status: 401 }))
    expect((await testProvider('deepgram', 'k', '', fetch401 as never)).message).toContain(
      'rejected',
    )
    expect((await testProvider('clerk', 'pk_test_x', '', fetchOk as never)).ok).toBe(false)
    expect((await testProvider('clerk', SK, 'pk_live_abc', fetchOk as never)).message).toContain(
      'different Clerk instances',
    )
    expect((await testProvider('github', 'k', '', fetchOk as never)).ok).toBe(false)
    expect((await testProvider('anthropic', '', '', fetchOk as never)).ok).toBe(false)
  })
})
