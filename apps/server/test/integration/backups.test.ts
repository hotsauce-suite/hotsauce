import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { restoreBackup } from '../../src/backup/index.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { MemoryObjectStore } from '../../src/storage/s3.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ADMIN = { 'x-hearth-dev-user': 'ada@example.org' }
const MEMBER = { 'x-hearth-dev-user': 'max@example.org' }

let root: string | undefined
const open: Services[] = []

afterEach(async () => {
  for (const s of open.splice(0)) s.index.close()
  if (root) await removeDir(root)
  root = undefined
})

async function server(dataDir: string, remotes: string, store: MemoryObjectStore | null) {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: dataDir,
    LOCAL_HOST_DIR: remotes,
    ALLOWED_EMAIL_DOMAINS: 'example.org',
    ADMIN_EMAILS: 'ada@example.org',
    PUBLIC_URL: 'https://office.acme.test',
  })
  const services = createServices(config, { backupStore: store })
  open.push(services)
  await services.spaces.ensureTeamSpace()
  const app = createApp(services)
  const call = (method: string, url: string, headers: Record<string, string>, json?: unknown) =>
    app.request(url, {
      method,
      headers: { ...headers, ...(json ? { 'content-type': 'application/json' } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    })
  return { services, call }
}

describe('backups through the API (R9) and a full restore (R7)', () => {
  it('admins see status and back up now; members get 403; off without a bucket', async () => {
    root = await makeTempDir('hotsauce-backups-')
    const off = await server(join(root, 'a'), join(root, 'ra'), null)
    expect(await (await off.call('GET', '/api/admin/org/backups', ADMIN)).json()).toEqual({
      enabled: false,
    })
    const s3 = new MemoryObjectStore()
    const { call } = await server(join(root, 'b'), join(root, 'rb'), s3)
    expect((await call('GET', '/api/admin/org/backups', MEMBER)).status).toBe(403)
    expect((await call('POST', '/api/admin/org/backups/run', MEMBER)).status).toBe(403)
    const ran = await (await call('POST', '/api/admin/org/backups/run', ADMIN)).json()
    expect(ran.status.lastError).toBeUndefined()
    const listed = await (await call('GET', '/api/admin/org/backups', ADMIN)).json()
    expect(listed.folder).toBe('backups/office.acme.test/')
    expect(listed.backups).toHaveLength(1)
    expect(listed.status.lastKey).toBe(listed.backups[0].key)
  })

  it('a server started on a restored folder serves the same document', async () => {
    root = await makeTempDir('hotsauce-backups-')
    // HOST_KIND=local keeps the bare repositories inside DATA_DIR, as an instance would.
    const dataDir = join(root, 'data')
    const remotes = join(dataDir, 'remotes')
    const s3 = new MemoryObjectStore()
    const first = await server(dataDir, remotes, s3)
    const saved = await first.call('PUT', '/api/spaces/team/file', ADMIN, {
      path: 'plan.md',
      content: '# Plan\n\nShip backups.\n',
      message: 'Plan',
    })
    expect(saved.status).toBe(200)
    const ran = await (await first.call('POST', '/api/admin/org/backups/run', ADMIN)).json()
    expect(ran.status.lastError).toBeUndefined()

    const restored = join(root, 'restored')
    await mkdir(restored)
    await restoreBackup({ s3, key: ran.status.lastKey, target: restored })
    const second = await server(restored, join(restored, 'remotes'), null)
    await second.services.indexer.full('team')
    const res = await second.call('GET', '/api/spaces/team/file?path=plan.md', ADMIN)
    expect(res.status).toBe(200)
    expect((await res.json()).content).toContain('Ship backups.')
    const history = await second.call('GET', '/api/spaces/team/history?path=plan.md', ADMIN)
    expect((await history.json()).length).toBeGreaterThan(0)
    expect(await readFile(join(restored, 'repos/team/plan.md'), 'utf8')).toContain('Ship backups.')
  })
})
