import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { OrgStore } from './store.js'
import { testForgejo, testStorage } from './test-keys.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function store() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hotsauce-org-'))
  dirs.push(dataDir)
  return new OrgStore({ dataDir, masterKey: 'test-master-key', env: {} })
}

describe('wizard settings become config (R10, R11)', () => {
  it('Forgejo: HOST_KIND=forgejo with its address, org and token', () => {
    const org = store()
    org.saveSettings({
      hostKind: 'forgejo',
      forgejoUrl: 'https://git.acme.test',
      forgejoOrg: 'acme',
      setupComplete: true,
    })
    org.saveSecret('FORGEJO_TOKEN', 'tok')
    const env = org.toEnv()
    expect(env).toMatchObject({
      HOST_KIND: 'forgejo',
      FORGEJO_URL: 'https://git.acme.test',
      FORGEJO_ORG: 'acme',
      FORGEJO_TOKEN: 'tok',
    })
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DATA_DIR: '/tmp/x', ...env })
    expect(config.HOST_KIND).toBe('forgejo')
  })

  it('any S3 endpoint: S3_* variables, which the media store and backups use', () => {
    const org = store()
    org.saveSettings({
      s3Endpoint: 'https://s3.eu-west-2.amazonaws.com',
      s3Region: 'eu-west-2',
      r2AccessKeyId: 'AKIA',
      r2Bucket: 'acme-media',
      setupComplete: true,
    })
    org.saveSecret('R2_SECRET_ACCESS_KEY', 'shh')
    const env = org.toEnv()
    expect(env).toMatchObject({
      S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
      S3_REGION: 'eu-west-2',
      S3_BUCKET: 'acme-media',
      S3_ACCESS_KEY_ID: 'AKIA',
      S3_SECRET_ACCESS_KEY: 'shh',
    })
    expect(env.R2_ACCOUNT_ID).toBeUndefined()
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', DATA_DIR: '/tmp/x', ...env })
    expect(config.OBJECT_STORE).toMatchObject({
      endpoint: 'https://s3.eu-west-2.amazonaws.com',
      bucket: 'acme-media',
    })
    expect(config.AUDIO_STORE).toBe('r2')
  })

  it('R2 by account id, as before', () => {
    const org = store()
    org.saveSettings({
      r2AccountId: 'acct',
      r2AccessKeyId: 'id',
      r2Bucket: 'b',
      setupComplete: true,
    })
    org.saveSecret('R2_SECRET_ACCESS_KEY', 's')
    expect(org.toEnv()).toMatchObject({ R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'b' })
    expect(org.toEnv().S3_ENDPOINT).toBeUndefined()
  })
})

describe('test buttons', () => {
  it('Forgejo: asks the org endpoint with the token, and says what failed', async () => {
    const seen: Request[] = []
    const ok = (async (i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(i, init))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    expect(await testForgejo('https://git.acme.test/', 'acme', 'tok', ok)).toMatchObject({
      ok: true,
    })
    expect(seen[0]?.url).toBe('https://git.acme.test/api/v1/orgs/acme')
    expect(seen[0]?.headers.get('authorization')).toBe('token tok')
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await testForgejo('https://git.acme.test', 'nope', 'tok', missing)).message).toContain(
      'can’t find',
    )
    expect((await testForgejo('', 'acme', 'tok', ok)).ok).toBe(false)
  })

  it('storage: writes, reads back and deletes a test object on the given endpoint', async () => {
    const methods: string[] = []
    const objects = new Map<string, string>()
    const fake = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(i, init)
      methods.push(`${req.method} ${new URL(req.url).host}`)
      const key = new URL(req.url).pathname
      if (req.method === 'PUT') objects.set(key, await req.text())
      if (req.method === 'GET') {
        const v = objects.get(key)
        return v === undefined ? new Response('', { status: 404 }) : new Response(v)
      }
      if (req.method === 'DELETE') objects.delete(key)
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const r = await testStorage(
      {
        endpoint: 'https://minio.acme.test',
        region: 'us-east-1',
        accountId: '',
        accessKeyId: 'k',
        bucket: 'media',
        secretAccessKey: 's',
      },
      fake,
    )
    expect(r).toMatchObject({ ok: true })
    expect(methods).toEqual([
      'PUT minio.acme.test',
      'GET minio.acme.test',
      'DELETE minio.acme.test',
    ])
    expect(objects.size).toBe(0)
    const denied = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch
    const bad = await testStorage(
      {
        endpoint: '',
        region: '',
        accountId: 'acct',
        accessKeyId: 'k',
        bucket: 'media',
        secretAccessKey: 's',
      },
      denied,
    )
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('403')
  })
})
