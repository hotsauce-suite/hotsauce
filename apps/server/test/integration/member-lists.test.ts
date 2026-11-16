import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { type Config, loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

/** Stars, rail pins and recents live in account.sqlite, not the index (docs/PLAN-member-lists.md). */

const ALICE = 'alice@acme.example'

let root: string
let config: Config
let services: Services
let app: ReturnType<typeof createApp>

async function start() {
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  await services.indexer.full('team')
  app = createApp(services)
}

function stop() {
  services.index.close()
  services.account.close()
}

beforeEach(async () => {
  root = await makeTempDir('hotsauce-lists-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'acme.example',
  })
  await start()
})

afterEach(async () => {
  stop()
  await removeDir(root)
})

async function call(method: string, path: string, json?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      'x-hearth-dev-user': ALICE,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  expect(res.status, `${method} ${path}`).toBe(200)
  return res.json()
}

async function lists() {
  return {
    stars: await call('GET', '/api/stars'),
    pins: await call('GET', '/api/pins'),
    recents: await call('GET', '/api/recents'),
  }
}

describe('member lists survive', () => {
  it('a deleted and rebuilt index (R3)', async () => {
    await call('PUT', '/api/spaces/team/file', { path: 'docs/plan.md', content: '# Plan\n' })
    await call('POST', '/api/stars', { space: 'team', path: 'docs/plan.md', starred: true })
    await call('POST', '/api/recents', { space: 'team', path: 'docs/plan.md' })
    await call('PUT', '/api/pins', { pins: ['tasks', 'docs'] })
    const before = await lists()
    expect(before.stars).toEqual([{ space: 'team', path: 'docs/plan.md', title: 'Plan' }])

    stop()
    await rm(join(config.DATA_DIR, 'index.sqlite'))
    await start()
    expect(await lists()).toEqual(before)
  })

  it('the upgrade from a release that kept them in the index (R4)', async () => {
    await call('PUT', '/api/spaces/team/file', { path: 'docs/plan.md', content: '# Plan\n' })
    stop()
    // What an older release left: no account.sqlite, the lists in index.sqlite.
    await rm(join(config.DATA_DIR, 'account.sqlite'))
    const raw = new Database(join(config.DATA_DIR, 'index.sqlite'))
    const at = '2026-11-10T09:00:00.000Z'
    raw.prepare('INSERT INTO recents VALUES (?, ?, ?, ?)').run(ALICE, 'team', 'docs/plan.md', at)
    raw.prepare('INSERT INTO stars VALUES (?, ?, ?)').run(ALICE, 'team', 'docs/plan.md')
    raw.prepare('INSERT INTO pins VALUES (?, ?)').run(ALICE, '["chat","today"]')
    raw.close()

    await start()
    expect(await lists()).toEqual({
      stars: [{ space: 'team', path: 'docs/plan.md', title: 'Plan' }],
      pins: { pins: ['chat', 'today'] },
      recents: [{ space: 'team', path: 'docs/plan.md', title: 'Plan', openedAt: at }],
    })

    // Copied once: an unstar sticks through the next restart.
    await call('POST', '/api/stars', { space: 'team', path: 'docs/plan.md', starred: false })
    stop()
    await start()
    expect(await call('GET', '/api/stars')).toEqual([])
  })
})
