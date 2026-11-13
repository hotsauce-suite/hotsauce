import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { moveReposToLocal } from '../../src/hosts/move-to-local.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const ADMIN = { 'x-hearth-dev-user': 'ada@example.org', 'content-type': 'application/json' }
let root: string | undefined
const open: Services[] = []

afterEach(async () => {
  for (const s of open.splice(0)) s.index.close()
  if (root) await removeDir(root)
  root = undefined
})

async function server(dataDir: string, hostDir: string) {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: dataDir,
    LOCAL_HOST_DIR: hostDir,
    ALLOWED_EMAIL_DOMAINS: 'example.org',
    ADMIN_EMAILS: 'ada@example.org',
  })
  const services = createServices(config)
  open.push(services)
  await services.spaces.ensureTeamSpace()
  const app = createApp(services)
  const call = (method: string, url: string, json?: unknown) =>
    app.request(url, { method, headers: ADMIN, ...(json ? { body: JSON.stringify(json) } : {}) })
  return { services, call }
}

describe('moving documents from a git host to the server’s disk (R12)', () => {
  it('copies every branch, verifies it, and the server keeps working on the new home', async () => {
    root = await makeTempDir('hotsauce-move-')
    const dataDir = join(root, 'data')
    // The "old host": bare repositories somewhere else, as GitHub would hold them.
    const oldHost = join(root, 'old-host')
    const first = await server(dataDir, oldHost)
    const saved = await first.call('PUT', '/api/spaces/team/file', {
      path: 'plan.md',
      content: '# Plan\n\nMove the docs.\n',
      message: 'Plan',
    })
    expect(saved.status).toBe(200)
    await first.services.syncer.afterHeadChanged?.('team')
    await first.services.git.drain()
    const oldTip = (await runGit(join(oldHost, 'team.git'), ['rev-parse', 'main'])).trim()

    const newHome = join(dataDir, 'remotes')
    const moved = await moveReposToLocal({ dataDir, localDir: newHome })
    expect(moved.map((m) => m.space)).toContain('team')
    expect((await runGit(join(newHome, 'team.git'), ['rev-parse', 'main'])).trim()).toBe(oldTip)
    // The copy doesn't remember the old host (its URL can carry a token).
    expect(await runGit(join(newHome, 'team.git'), ['remote'])).toBe('')
    // The working clone already points at its new home, before any restart.
    expect(
      (await runGit(join(dataDir, 'repos/team'), ['remote', 'get-url', 'origin'])).trim(),
    ).toBe(pathToFileURL(join(newHome, 'team.git')).href)
    // Running it again is harmless.
    expect(
      (await moveReposToLocal({ dataDir, localDir: newHome })).every(
        (m) => m.branches > 0 || m.skipped,
      ),
    ).toBe(true)

    for (const s of open.splice(0)) s.index.close()
    const second = await server(dataDir, newHome)
    const read = await second.call('GET', '/api/spaces/team/file?path=plan.md')
    expect((await read.json()).content).toContain('Move the docs.')
    expect(
      (await runGit(join(dataDir, 'repos/team'), ['remote', 'get-url', 'origin'])).trim(),
    ).toContain('/data/remotes/team.git')
    const again = await second.call('PUT', '/api/spaces/team/file', {
      path: 'plan.md',
      content: '# Plan\n\nMoved.\n',
      message: 'Moved',
    })
    expect(again.status).toBe(200)
    await second.services.syncer.afterHeadChanged?.('team')
    await second.services.git.drain()
    const log = await runGit(join(newHome, 'team.git'), ['log', '--format=%s', 'main'])
    expect(log).toContain('Moved')
    // The old host never changed.
    expect((await runGit(join(oldHost, 'team.git'), ['rev-parse', 'main'])).trim()).toBe(oldTip)
  })
})
