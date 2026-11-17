import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Who a read-only link is for and when it ends; clip and file links (docs/PLAN-outside-links.md).

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const GUEST = 'guest@elsewhere.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-outside-links-')
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

const allowAnyone = (on = true) => api('PUT', '/api/sharing', { json: { publicShareLinks: on } })

const shareDoc = (path: string, extra: Record<string, unknown> = {}, as = ALICE, status = 200) =>
  api('POST', '/api/shares', { as, json: { space: 'team', path, on: true, ...extra }, status })

/** Moves the clock the link store reads by `days`. */
function later(days: number) {
  const real = Date.now
  const at = real() + days * 86_400_000
  Date.now = () => at
  return () => {
    Date.now = real
  }
}

async function readyClip(as = ALICE) {
  const clip = await api('POST', '/api/clips', {
    as,
    json: { mode: 'screen', container: 'mp4', title: 'Demo for Acme' },
    status: 201,
  })
  services.clips.store.update(
    clip.id,
    {
      status: 'ready',
      durationMs: 12_000,
      width: 1920,
      height: 1080,
      summary: 'A walk through the new dashboard.',
      transcriptStatus: 'ready',
      transcript: [
        { start: 0, end: 2, text: 'Hello Acme.', speaker: 0 },
        { start: 2, end: 4, text: 'Here is the dashboard.', speaker: 0 },
      ],
      aiSummary: 'PRIVATE AI NOTES',
      aiActions: '- [ ] PRIVATE ACTION',
    },
    new Date().toISOString(),
  )
  return clip as { id: string }
}

describe('who a link is for and when it ends', () => {
  it('records the audience and ends after 30 days by default (R1, R4)', async () => {
    await writeDoc('team', 'docs/a.md', '# A\n')
    const on = await shareDoc('docs/a.md')
    expect(on.link.anyone).toBe(false)
    const days = (Date.parse(on.link.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)
    expect(on.link.ended).toBe(false)
    expect((await api('GET', `/api/shared/${on.token}`, { as: BOB })).title).toBe('A')

    const restore = later(31)
    try {
      await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 410 })
      const state = await api('GET', '/api/shares?space=team&path=docs/a.md')
      expect(state.link.ended).toBe(true)
      // Turning it on again makes a fresh link with a new token.
      const fresh = await shareDoc('docs/a.md')
      expect(fresh.token).not.toBe(on.token)
      expect(fresh.link.ended).toBe(false)
      expect((await api('GET', `/api/shared/${fresh.token}`, { as: BOB })).title).toBe('A')
      await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 404 })
    } finally {
      restore()
    }
  })

  it('offers 7 days and never, and refuses anything else', async () => {
    await writeDoc('team', 'docs/b.md', '# B\n')
    await writeDoc('team', 'docs/c.md', '# C\n')
    await shareDoc('docs/b.md', { expiresDays: 14 }, ALICE, 400)
    const week = await shareDoc('docs/b.md', { expiresDays: 7 })
    expect((Date.parse(week.link.expiresAt) - Date.now()) / 86_400_000).toBeCloseTo(7, 1)
    const never = await shareDoc('docs/c.md', { expiresDays: 0 })
    expect(never.link.expiresAt).toBeNull()
    const restore = later(3650)
    try {
      expect((await api('GET', `/api/shared/${never.token}`, { as: BOB })).title).toBe('C')
      await api('GET', `/api/shared/${week.token}`, { as: BOB, status: 410 })
    } finally {
      restore()
    }
  })

  it('opens an "anyone" link signed out, and nothing else (R2, R3, R5)', async () => {
    await writeDoc('team', 'docs/in.md', '# In\n')
    await writeDoc('team', 'docs/out.md', '# Out\n')
    await shareDoc('docs/out.md', { anyone: true }, ALICE, 400)
    await allowAnyone()
    const inside = await shareDoc('docs/in.md')
    const outside = await shareDoc('docs/out.md', { anyone: true })
    expect((await api('GET', `/api/shared/${outside.token}`, { as: null })).title).toBe('Out')
    await api('GET', `/api/shared/${inside.token}`, { as: null, status: 401 })
    // Signed in, both open.
    expect((await api('GET', `/api/shared/${inside.token}`, { as: BOB })).title).toBe('In')
    expect((await api('GET', `/api/shared/${outside.token}`, { as: GUEST })).title).toBe('Out')
    await allowAnyone(false)
    await api('GET', `/api/shared/${outside.token}`, { as: null, status: 401 })
  })

  it('keeps a link made before the change open to members, never ending (R10)', async () => {
    await writeDoc('team', 'docs/old.md', '# Old\n')
    const on = await shareDoc('docs/old.md')
    // A link from before has no record.
    services.shareLinks.delete(on.token)
    await allowAnyone()
    await api('GET', `/api/shared/${on.token}`, { as: null, status: 401 })
    const restore = later(400)
    try {
      expect((await api('GET', `/api/shared/${on.token}`, { as: BOB })).title).toBe('Old')
      const state = await api('GET', '/api/shares?space=team&path=docs/old.md')
      expect(state.link).toEqual({ anyone: false, expiresAt: null, ended: false })
    } finally {
      restore()
    }
  })

  it('lists links for an admin, who can turn one off at once (R8)', async () => {
    await allowAnyone()
    await writeDoc('team', 'docs/l.md', '# Listed\n', BOB)
    const on = await shareDoc('docs/l.md', { anyone: true }, BOB)
    await api('GET', '/api/share-links', { as: BOB, status: 403 })
    const { links } = await api('GET', '/api/share-links')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      token: on.token,
      kind: 'doc',
      title: 'Listed',
      anyone: true,
      ended: false,
      url: `/s/${on.token}`,
      createdBy: { email: BOB },
    })
    await api('DELETE', `/api/share-links/${on.token}`, { as: BOB, status: 403 })
    await api('DELETE', `/api/share-links/${on.token}`, { status: 204 })
    await api('GET', `/api/shared/${on.token}`, { as: null, status: 410 })
    await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 410 })
    expect((await api('GET', '/api/share-links')).links[0].ended).toBe(true)
    await api('DELETE', '/api/share-links/AAAAAAAAAAAAAAAAAAAAAAAA', { status: 404 })
  })
})

describe('clip links (R6)', () => {
  it('shows the video, title, summary and transcript, and nothing private', async () => {
    const clip = await readyClip()
    expect(await api('GET', `/api/clips/${clip.id}/share`, { as: BOB })).toEqual({
      token: null,
      url: null,
      link: null,
    })
    // Only the person who recorded it can share it.
    await api('POST', `/api/clips/${clip.id}/share`, { as: BOB, json: { on: true }, status: 403 })
    await api('POST', `/api/clips/${clip.id}/share`, {
      json: { on: true, anyone: true },
      status: 400,
    })
    await allowAnyone()
    const on = await api('POST', `/api/clips/${clip.id}/share`, {
      json: { on: true, anyone: true, expiresDays: 7 },
    })
    expect(on.url).toBe(`/s/${on.token}`)
    expect(on.link).toMatchObject({ anyone: true, ended: false })
    // A repeat keeps the same link.
    expect((await api('POST', `/api/clips/${clip.id}/share`, { json: { on: true } })).token).toBe(
      on.token,
    )
    expect((await api('GET', `/api/clips/${clip.id}/share`, { as: BOB })).token).toBe(on.token)

    const seen = await api('GET', `/api/shared/${on.token}`, { as: null })
    expect(seen).toMatchObject({
      kind: 'clip',
      title: 'Demo for Acme',
      summary: 'A walk through the new dashboard.',
      durationMs: 12_000,
      updatedBy: 'Alice',
    })
    expect(seen.transcript).toEqual([
      { start: 0, end: 2, text: 'Hello Acme.', speaker: 'Alice' },
      { start: 2, end: 4, text: 'Here is the dashboard.', speaker: 'Alice' },
    ])
    expect(seen.videoUrl).toMatch(/^\/api\/clips\/media\//)
    const text = JSON.stringify(seen)
    for (const hidden of ['PRIVATE', 'downloadUrl', ALICE, clip.id + '/source']) {
      expect(text).not.toContain(hidden)
    }

    await api('POST', `/api/clips/${clip.id}/share`, { json: { on: false } })
    await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 404 })
    await api('GET', `/api/shared/${on.token}`, { as: null, status: 401 })
  })

  it('ends the link when the clip is deleted, and refuses a clip that is not ready', async () => {
    const recording = await api('POST', '/api/clips', {
      json: { mode: 'screen', container: 'mp4' },
      status: 201,
    })
    await api('POST', `/api/clips/${recording.id}/share`, { json: { on: true }, status: 409 })
    const clip = await readyClip()
    const on = await api('POST', `/api/clips/${clip.id}/share`, { json: { on: true } })
    expect((await api('GET', `/api/shared/${on.token}`, { as: BOB })).kind).toBe('clip')
    await api('DELETE', `/api/clips/${clip.id}`, { status: 204 })
    await api('GET', `/api/shared/${on.token}`, { as: BOB, status: 404 })
    expect(services.shareLinks.get(on.token)).toBeNull()
  })
})

describe('file links (R7)', () => {
  it('opens an "anyone" file link signed out, with view and download URLs', async () => {
    const bytes0 = Buffer.from('%PDF-1.4\n%%EOF\n')
    const started = await api('POST', '/api/files/uploads', {
      status: 201,
      json: { space: 'alice', folder: '', name: 'deck.pdf', size: bytes0.length },
    })
    const put = await app.request(`/api/files/uploads/${started.id}/chunks/0`, {
      method: 'PUT',
      headers: { 'x-hearth-dev-user': ALICE },
      body: bytes0,
    })
    expect(put.status).toBe(204)
    const f = await api('POST', `/api/files/uploads/${started.id}/complete`)

    await allowAnyone()
    const inside = await api('POST', `/api/files/item/alice/${f.id}/share`, { json: { on: true } })
    expect(inside.shareUrl).toBe(`/files/s/${inside.shareToken}`)
    expect(inside.shareLink).toMatchObject({ anyone: false })
    await api('GET', `/api/shared/${inside.shareToken}`, { as: null, status: 401 })
    expect((await api('GET', `/api/shared/${inside.shareToken}`, { as: BOB })).kind).toBe('file')

    // Turning it off and on again for anyone makes a new link.
    await api('POST', `/api/files/item/alice/${f.id}/share`, { json: { on: false } })
    const outside = await api('POST', `/api/files/item/alice/${f.id}/share`, {
      json: { on: true, anyone: true },
    })
    expect(outside.shareUrl).toBe(`/s/${outside.shareToken}`)
    const seen = await api('GET', `/api/shared/${outside.shareToken}`, { as: null })
    expect(seen).toMatchObject({ kind: 'file', title: 'deck.pdf', file: { name: 'deck.pdf' } })
    // Nothing says where it sits (the local store's signed media URLs name the space; R2's don't).
    const { contentUrl: _c, downloadUrl: _d, ...about } = seen.file
    expect(JSON.stringify({ ...seen, file: about })).not.toContain('alice')
    const bytes = await call('GET', seen.file.contentUrl)
    expect(bytes.status).toBe(200)
    expect((await call('GET', seen.file.downloadUrl)).status).toBe(200)
  })
})
