import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import type { UsageReport } from '../../src/usage/index.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// docs/PLAN-app-usage.md: the admin Usage report, counted from real Git history in every space.

const ADMIN = 'ada@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-usage-')
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      ADMIN_EMAILS: ADMIN,
    }),
  )
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', ADMIN)
  await call('GET', '/api/me', BOB)
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  services.clips.store.close()
  await removeDir(root)
})

function call(method: string, url: string, as: string, headers: Record<string, string> = {}) {
  return app.request(url, { method, headers: { 'x-hearth-dev-user': as, ...headers } })
}

async function report(): Promise<UsageReport> {
  const res = await call('GET', '/api/admin/usage', ADMIN)
  expect(res.status).toBe(200)
  return (await res.json()) as UsageReport
}

const author = (email: string) => ({ name: email.split('@')[0] ?? email, email })

describe('GET /api/admin/usage', () => {
  it('is for admins only, and never through an access token (U1)', async () => {
    expect((await call('GET', '/api/admin/usage', BOB)).status).toBe(403)
    const created = await app.request('/api/tokens', {
      method: 'POST',
      headers: { 'x-hearth-dev-user': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Claude' }),
    })
    const { token } = (await created.json()) as { token: string }
    const viaToken = await app.request('/api/admin/usage', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(viaToken.status).toBe(403)
  })

  it('counts each app from the team and personal spaces, not Hotsauce’s own commits (U2–U6)', async () => {
    const git = services.git
    await git.commit('team', {
      changes: [
        { path: 'tasks/01A.md', content: 'one' },
        { path: 'docs/Plan.md', content: 'plan' },
      ],
      author: author(ADMIN),
      message: 'tasks: add',
    })
    await git.commit('team', {
      changes: [{ path: 'tasks/01A.md', content: 'one, edited' }],
      author: author(BOB),
      message: 'tasks: edit',
    })
    await git.move('team', 'docs/Plan.md', 'docs/Plan v2.md', author(BOB))
    // Hotsauce writing on its own behalf (its committer as author) is nobody using an app.
    const self = {
      name: services.config.HOTSAUCE_COMMITTER_NAME,
      email: services.config.HOTSAUCE_COMMITTER_EMAIL,
    }
    await git.commit('team', {
      changes: [{ path: 'checkins/x.md', content: 'summary' }],
      author: self,
      message: 'checkins: summary',
    })
    // Bob's personal space: a saved link.
    const spaces = await services.git.listClones()
    const bobSpace = spaces.find((s) => s !== 'team')
    expect(bobSpace).toBeDefined()
    await git.commit(bobSpace as string, {
      changes: [{ path: 'links/01B.md', content: 'a link' }],
      author: author(BOB),
      message: 'links: save',
    })

    const r = await report()
    const byId = Object.fromEntries(r.apps.map((a) => [a.id, a]))
    expect(byId.tasks?.weeks.at(-1)).toMatchObject({ created: 1, changed: 1, people: 2 })
    // The rename is a change to the doc, not a second doc.
    expect(byId.docs?.total).toEqual({ created: 1, changed: 2, people: 2 })
    expect(byId.links?.total).toEqual({ created: 1, changed: 1, people: 1 })
    expect(byId.checkins?.total.changed).toBe(0)
    expect(JSON.stringify(r)).not.toContain('Plan')
    expect(JSON.stringify(r)).not.toContain('@')
  })

  it('counts clips and Dictate Macs from their own records (U7, U8)', async () => {
    const now = new Date().toISOString()
    services.clips.store.create({
      id: 'clip1',
      owner: { userId: 'dev:bob', email: BOB, name: 'Bob' },
      title: 'Demo',
      mode: 'screen',
      container: 'webm',
      now,
    })
    services.dictation.store.createDevice({ userId: 'dev:bob', email: BOB }, 'Bob’s Mac')
    const r = await report()
    expect(r.apps.find((a) => a.id === 'clips')?.weeks.at(-1)).toMatchObject({
      created: 1,
      people: 1,
    })
    expect(r.dictate).toEqual({ connectedMacs: 1, usedLast7Days: 0 })
  })

  it('still finds recent work under a commit with an old date on top', async () => {
    await services.git.commit('team', {
      changes: [{ path: 'tables/01D.md', content: 'recent' }],
      author: author(BOB),
      message: 'tables: add',
    })
    // An outside push or an import can put old-dated commits above recent ones.
    const dir = join(services.config.DATA_DIR, 'repos', 'team')
    const old = '2020-01-01T00:00:00Z'
    for (let i = 0; i < 12; i++) {
      await promisify(execFile)(
        'git',
        [
          '-c',
          'user.name=Old',
          '-c',
          'user.email=old@example.test',
          'commit',
          '--allow-empty',
          '-qm',
          `old ${i}`,
        ],
        { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } },
      )
    }
    const r = await report()
    expect(r.apps.find((a) => a.id === 'tables')?.total.changed).toBe(1)
  })

  it('serves the same numbers from memory for 10 minutes (U10)', async () => {
    const first = await report()
    await services.git.commit('team', {
      changes: [{ path: 'notes/01C.md', content: 'note' }],
      author: author(BOB),
      message: 'notes: add',
    })
    const second = await report()
    expect(second.generatedAt).toBe(first.generatedAt)
    expect(second.apps.find((a) => a.id === 'notes')?.total.changed).toBe(0)
  })
})
