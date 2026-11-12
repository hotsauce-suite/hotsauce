import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Read-only links (docs/plans/2026-11-12-share-pages.md R1–R6, ARCHITECTURE §20).

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const GUEST = 'guest@elsewhere.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-shares-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ALLOWED_EMAILS: GUEST,
    ADMIN_EMAILS: ALICE,
    AUDIO_STORE: 'local',
  })
  services = createServices(config, { llm: new FakeLLM(scriptedResponse) })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

interface Options {
  as?: string | null
  json?: unknown
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  url: string,
  opts: Options & { status?: number } = {},
): Promise<T> {
  const res = await call(method, url, { as: ALICE, ...opts })
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

const lastCommit = async (space: string) =>
  (
    await runGit(join(root, 'remotes', `${space}.git`), ['log', '-1', '--format=%an|%s', 'main'])
  ).trim()

async function writeDoc(space: string, path: string, content: string, as = ALICE) {
  return api('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })
}

const share = (space: string, path: string, on: boolean, as = ALICE, status = 200) =>
  api('POST', '/api/shares', { as, json: { space, path, on }, status })

describe('read-only links', () => {
  it('turns a link on and off for a doc, and the link shows the latest version (R1, R3)', async () => {
    await writeDoc('team', 'docs/plan.md', '# Q4 plan\n\nShip Files.\n')
    const on = await share('team', 'docs/plan.md', true)
    expect(on.token).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(on.url).toBe(`/s/${on.token}`)
    expect(await lastCommit('team')).toBe('Alice|docs: share "Q4 plan"')
    // Repeating is a no-op: same token, no new commit.
    const again = await share('team', 'docs/plan.md', true)
    expect(again.token).toBe(on.token)
    expect(await lastCommit('team')).toBe('Alice|docs: share "Q4 plan"')
    expect(await api('GET', '/api/shares?space=team&path=docs/plan.md')).toEqual(on)

    const seen = await api('GET', `/api/shared/${on.token}`, { as: BOB })
    expect(seen).toMatchObject({ kind: 'doc', title: 'Q4 plan', updatedBy: 'Alice' })
    expect(seen.markdown).toBe('# Q4 plan\n\nShip Files.\n')
    expect(JSON.stringify(seen)).not.toContain('docs/plan.md')
    expect(JSON.stringify(seen)).not.toContain('team')

    // An edit shows up at the same link; the token survives the save.
    const file = await api('GET', '/api/spaces/team/file?path=docs/plan.md')
    expect(file.content).toContain(`share: ${on.token}`)
    await writeDoc('team', 'docs/plan.md', file.content.replace('Ship Files.', 'Ship Pages.'))
    expect((await api('GET', `/api/shared/${on.token}`, { as: BOB })).markdown).toContain(
      'Ship Pages.',
    )

    const off = await share('team', 'docs/plan.md', false)
    expect(off).toEqual({ token: null, url: null })
    expect(await lastCommit('team')).toBe('Alice|docs: unshare "Q4 plan"')
    await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 404 })
  })

  it('shares a note and a meeting note, but not a transcript, task or Files pointer (R2)', async () => {
    const note = await api('POST', '/api/notes', {
      json: { title: 'Lab list', body: 'Pipettes' },
      status: 201,
    })
    const n = await share(note.space, `notes/${note.id}.md`, true)
    expect(await lastCommit(note.space)).toBe('Alice|notes: share "Lab list"')
    const seenNote = await api('GET', `/api/shared/${n.token}`, { as: BOB })
    expect(seenNote).toMatchObject({ kind: 'note', title: 'Lab list' })
    expect(seenNote.markdown).toContain('Pipettes')
    // The note still reads as a note in Notes, link and all.
    expect((await api('GET', `/api/notes/${note.space}/${note.id}`)).title).toBe('Lab list')

    const meeting = 'meetings/2026/11/2026-11-12-standup.md'
    await writeDoc(
      'team',
      meeting,
      '---\nid: m1\ntype: meeting\ntitle: Standup\ndate: 2026-11-12\n---\n# Standup\n\n## Notes\nAll good.\n',
    )
    const m = await share('team', meeting, true)
    expect(await lastCommit('team')).toBe('Alice|meetings: share "Standup"')
    expect(await api('GET', `/api/shared/${m.token}`, { as: BOB })).toMatchObject({
      kind: 'meeting',
      title: 'Standup',
    })

    await writeDoc('team', 'meetings/2026/11/2026-11-12-standup.transcript.md', '# t\n')
    await share('team', 'meetings/2026/11/2026-11-12-standup.transcript.md', true, ALICE, 400)
    await writeDoc('team', 'tasks/t1.md', '---\nid: t1\ntype: task\ntitle: T\n---\n')
    await share('team', 'tasks/t1.md', true, ALICE, 400)
    await share('team', 'files/01JABCDEFGHJKMNPQRSTVWXYZ0.md', true, ALICE, 400)
    await share('team', 'docs/missing.md', true, ALICE, 404)
  })

  it('keeps personal spaces private, except through a link (R2, R4)', async () => {
    await writeDoc('alice', 'docs/mine.md', '# Mine\n')
    await share('alice', 'docs/mine.md', true, BOB, 403)
    await api('GET', '/api/shares?space=alice&path=docs/mine.md', { as: BOB, status: 403 })
    const { token } = await share('alice', 'docs/mine.md', true)
    expect((await api('GET', `/api/shared/${token}`, { as: BOB })).title).toBe('Mine')
    // An invited person can open it too.
    expect((await api('GET', `/api/shared/${token}`, { as: GUEST })).title).toBe('Mine')
  })

  it('is closed to signed-out people unless the organization allows it (R4, R6)', async () => {
    await writeDoc('team', 'docs/open.md', '# Open\n')
    const { token } = await share('team', 'docs/open.md', true)
    await api('GET', `/api/shared/${token}`, { as: null, status: 401 })
    // A bad token is 404 whether or not anyone is signed in, so no guess learns anything.
    await api('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAAAAAA', { as: null, status: 401 })
    await api('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAAAAAA', { as: BOB, status: 404 })

    // Only an admin can turn it on.
    expect(await api('GET', '/api/sharing', { as: BOB })).toEqual({ publicShareLinks: false })
    await api('PUT', '/api/sharing', { as: BOB, json: { publicShareLinks: true }, status: 403 })
    expect(await api('PUT', '/api/sharing', { json: { publicShareLinks: true } })).toEqual({
      publicShareLinks: true,
    })
    expect(services.org.settings().publicShareLinks).toBe(true)
    // At once, without a restart.
    expect((await api('GET', `/api/shared/${token}`, { as: null })).title).toBe('Open')
    await api('GET', '/api/shared/AAAAAAAAAAAAAAAAAAAAAAAA', { as: null, status: 404 })
    const health = await api('GET', '/api/health', { as: null })
    expect(JSON.stringify(health)).not.toContain('publicShareLinks')

    await api('PUT', '/api/sharing', { json: { publicShareLinks: false } })
    await api('GET', `/api/shared/${token}`, { as: null, status: 401 })
  })

  it('serves only the images the shared doc shows, from assets/ (R5)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    await services.git.commit('team', {
      changes: [
        { path: 'assets/chart.png', content: png },
        { path: 'assets/secret.png', content: png },
      ],
      author: { name: 'alice', email: ALICE },
      message: 'assets',
    })
    await writeDoc('team', 'docs/report.md', '# Report\n\n![chart](../assets/chart.png)\n')
    await writeDoc('team', 'docs/other.md', '# Other\n\n[[secret]]\n')
    const { token } = await share('team', 'docs/report.md', true)

    const ok = await call('GET', `/api/shared/${token}/asset?src=../assets/chart.png`, { as: BOB })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png)
    // Not in the doc, outside assets/, or markdown: refused.
    for (const src of ['../assets/secret.png', '../docs/other.md', '/etc/passwd']) {
      const res = await call('GET', `/api/shared/${token}/asset?src=${encodeURIComponent(src)}`, {
        as: BOB,
      })
      expect(res.status, src).toBe(404)
    }
    // Signed out follows the same rule as the page.
    const anon = await call('GET', `/api/shared/${token}/asset?src=../assets/chart.png`)
    expect(anon.status).toBe(401)
  })

  it('a restore never revives a link that was turned off, nor ends one that is on', async () => {
    await writeDoc('team', 'docs/r.md', '# R\n\nv1\n')
    const { token } = await share('team', 'docs/r.md', true)
    const history = await api('GET', '/api/spaces/team/history?path=docs/r.md')
    const shared = history[0].oid
    await share('team', 'docs/r.md', false)
    await api('POST', '/api/spaces/team/restore', { json: { oid: shared, path: 'docs/r.md' } })
    await api('GET', `/api/shared/${token}`, { as: BOB, status: 404 })
    expect((await api('GET', '/api/shares?space=team&path=docs/r.md')).token).toBeNull()

    const again = await share('team', 'docs/r.md', true)
    const first = history[history.length - 1].oid
    await api('POST', '/api/spaces/team/restore', { json: { oid: first, path: 'docs/r.md' } })
    expect((await api('GET', `/api/shared/${again.token}`, { as: BOB })).markdown).toContain('v1')
  })
})
