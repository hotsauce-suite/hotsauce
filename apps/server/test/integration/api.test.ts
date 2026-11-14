import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { initialSpaceFiles, parseSpaceConfig } from '@hearth/format'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { type Config, loadConfig } from '../../src/config.js'
import { HearthError } from '../../src/errors.js'
import { runGit } from '../../src/git/index.js'
import { ForgejoHost } from '../../src/hosts/index.js'
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '../../src/index/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, OutsideEditor, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test' // an admin
const WEBHOOK_SECRET = 'test-webhook-secret'

let root: string
let config: Config
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hearth-api-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: CAROL,
    WEBHOOK_SECRET,
    IDLE_COMMIT_MS: '1500',
  })
  services = createServices(config)
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  services.index.close()
  await removeDir(root)
})

interface Options {
  as?: string
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
  return app.request(url, { method, headers, ...(body !== undefined ? { body } : {}) })
}

/** Calls as `as` (default Alice) and returns the parsed JSON body, failing on an unexpected status. */
// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function json<T = any>(
  method: string,
  url: string,
  opts: Options = {},
  status = 200,
): Promise<T> {
  const res = await call(method, url, { as: ALICE, ...opts })
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

const url = (space: string, route: string, query: Record<string, string> = {}) =>
  `/api/spaces/${space}/${route}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`

async function outside(space: string): Promise<OutsideEditor> {
  const { cloneUrl } = await services.host.ensureRepo(space)
  return OutsideEditor.clone(cloneUrl, join(root, `outside-${space}-${Date.now()}`))
}

describe('health and identity', () => {
  it('reports health and the auth mode without a session', async () => {
    const res = await call('GET', '/api/health')
    expect(res.status).toBe(200)
    const health = await res.json()
    expect(health).toMatchObject({ ok: true, authMode: 'dev', setupRequired: false })
    // Its own address, as an origin: the Mac app follows an instance that moved (LEGACY_HOSTS).
    expect(health.publicUrl).toMatch(/^https?:\/\/[^/]+$/)
  })

  it('rejects requests without a session, and unknown API routes with JSON errors', async () => {
    const res = await call('GET', '/api/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    })
    const missing = await json('GET', '/api/nope', {}, 404)
    expect(missing.error.code).toBe('not_found')
  })

  it('refuses request bodies over 12 MB with 413, and reads none before authenticating', async () => {
    const body = JSON.stringify({ path: 'docs/big.md', content: 'x'.repeat(12 * 1024 * 1024) })
    const headers = { 'content-type': 'application/json' }
    const anonymous = await call('PUT', url('team', 'file'), { body, headers })
    expect(anonymous.status).toBe(401)
    const res = await call('PUT', url('team', 'file'), { as: ALICE, body, headers })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request')
  })

  it('createOnly saves a new file but never overwrites one', async () => {
    const put = (content: string) =>
      call('PUT', url('team', 'file'), {
        as: ALICE,
        json: { path: 'docs/only-once.md', content, createOnly: true },
      })
    expect((await put('# First\n')).status).toBe(200)
    const again = await put('# Second\n')
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('conflict')
    expect((await services.git.readFile('team', 'docs/only-once.md'))?.content).toContain('# First')
  })

  it('enforces the domain lock', async () => {
    const body = await json('GET', '/api/me', { as: 'visitor@example.com' }, 403)
    expect(body.error.code).toBe('domain_not_allowed')
  })

  it('me provisions the personal space, owned by email in its space.yaml', async () => {
    const me = await json('GET', '/api/me')
    expect(me).toEqual({
      principal: {
        userId: `dev:${ALICE}`,
        email: ALICE,
        name: 'Alice',
        handle: 'alice',
        isAdmin: false,
      },
      spaces: [
        { name: 'team', kind: 'team', label: 'Team' },
        { name: 'alice', kind: 'personal', label: 'Personal' },
      ],
      settings: { idleCommitMs: 1500 },
    })
    const config = await services.git.readFile('alice', '.hearth/space.yaml')
    expect(parseSpaceConfig(config.content)).toMatchObject({ kind: 'personal', owner: ALICE })
    const tree = await json('GET', url('alice', 'tree'))
    expect(tree.map((e: { path: string }) => e.path)).toContain('README.md')
  })

  it('registers the push webhook on a personal space it provisions', async () => {
    const ensureWebhook = vi.spyOn(services.host, 'ensureWebhook')
    await json('GET', '/api/me')
    expect(ensureWebhook).toHaveBeenCalledWith(
      'alice',
      'http://localhost:3000/api/webhooks/git',
      WEBHOOK_SECRET,
    )
  })

  it('never shows one member another member’s personal space, admins included', async () => {
    await json('GET', '/api/me') // provisions alice
    for (const who of [BOB, CAROL]) {
      const body = await json('GET', url('alice', 'tree'), { as: who }, 403)
      expect(body.error.code).toBe('forbidden')
    }
    await json('GET', url('nobody', 'tree'), {}, 403)
  })
})

describe('personal space provisioning', () => {
  const TEAM = { name: 'team', kind: 'team', label: 'Team' }
  const hostDown = async (): Promise<never> => {
    throw new HearthError('host_error', 'Forgejo could not be reached')
  }

  it('leaves a member the team space when the host cannot provision theirs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      services.host.ensureRepo = hostDown
      expect((await json('GET', '/api/me')).spaces).toEqual([TEAM])
      await json('GET', url('team', 'tree'))
      await json('PUT', url('team', 'file'), { json: { path: 'docs/on.md', content: '# On\n' } })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain(`${ALICE} has team access only: host_error`)
    } finally {
      warn.mockRestore()
    }
  })

  it('boots and serves existing clones while the host is down', async () => {
    await json('GET', '/api/me') // provisions alice
    services.index.close()
    // A restart (main.ts provisions the team space first) with the host's API unreachable.
    services = createServices(config)
    services.host.ensureRepo = hostDown
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await services.spaces.ensureTeamSpace()
      app = createApp(services)
      expect((await json('GET', '/api/me')).spaces.map((s: { name: string }) => s.name)).toEqual([
        'team',
        'alice',
      ])
      await json('PUT', url('alice', 'file'), { json: { path: 'docs/a.md', content: '# A\n' } })
    } finally {
      warn.mockRestore()
    }
  })

  it('gives a member whose handle another member holds the team space only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await json('GET', '/api/me', { as: 'a.b@example.test' })
      const me = await json('GET', '/api/me', { as: 'a-b@example.test' })
      expect(me.principal.handle).toBe('a-b')
      expect(me.spaces).toEqual([TEAM])
      await json('GET', url('a-b', 'tree'), { as: 'a-b@example.test' }, 403)
      await json('GET', url('team', 'tree'), { as: 'a-b@example.test' })
    } finally {
      warn.mockRestore()
    }
  })

  it('honors the owner recorded in Git over whoever claims the handle first', async () => {
    // a.b@'s personal repo is on the host already (the index was lost, say), but not cloned here.
    const seed = initialSpaceFiles('a-b', { kind: 'personal', owner: 'a.b@example.test' })
    await (await outside('a-b')).push(Object.fromEntries(seed.map((f) => [f.path, f.content])))
    const claimant = {
      userId: 'dev:a-b@example.test',
      email: 'a-b@example.test',
      name: 'A-b',
      handle: 'a-b',
      isAdmin: false,
    }

    await expect(services.spaces.ensurePersonalSpace(claimant)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(services.index.getSpace('a-b')).toMatchObject({
      kind: 'personal',
      ownerEmail: 'a.b@example.test',
    })

    const owner = await json('GET', '/api/me', { as: 'a.b@example.test' })
    expect(owner.spaces.map((s: { name: string }) => s.name)).toEqual(['team', 'a-b'])
    await json('GET', url('a-b', 'file', { path: 'README.md' }), { as: 'a.b@example.test' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await json('GET', url('a-b', 'tree'), { as: claimant.email }, 403)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('files', () => {
  it('lists the tree and reads a file with its blob and HEAD', async () => {
    const tree = await json('GET', url('team', 'tree'))
    expect(tree[0]).toMatchObject({ type: 'dir' })
    expect(tree.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['.hearth', 'assets', 'docs', 'README.md']),
    )
    const file = await json('GET', url('team', 'file', { path: 'README.md' }))
    expect(file.content).toMatch(/^# team\n/)
    expect(file.blobOid).toMatch(/^[0-9a-f]{40}$/)
    expect(file.headOid).toBe(await services.git.headOid('team'))
    await json('GET', url('team', 'file', { path: 'docs/missing.md' }), {}, 404)
    const bad = await json('GET', url('team', 'file', { path: '../escape.md' }), {}, 400)
    expect(bad.error.code).toBe('bad_request')
  })

  it('PUT creates a doc with an id added, and returns the content the client must adopt', async () => {
    const sent = '# New doc\n\nHello.\n'
    const result = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/new.md', content: sent },
    })
    expect(result).toMatchObject({ status: 'committed', oid: expect.any(String) })
    expect(result.content).toMatch(/^---\nid: [0-9A-Z]{26}\n---\n# New doc\n\nHello\.\n$/)
    const file = await json('GET', url('team', 'file', { path: 'docs/new.md' }))
    expect(file.content).toBe(result.content)
    expect(file.blobOid).toBe(result.blobOid)

    const [commit] = await json('GET', url('team', 'history', { path: 'docs/new.md' }))
    expect(commit.message).toBe('docs: create "New doc"')
    expect(commit.author).toEqual({ name: 'Alice', email: ALICE })
  })

  it('PUT of an edit commits without echoing content, honoring message and label', async () => {
    const created = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/plan.md', content: '# Plan\n\nv1\n' },
    })
    const edited = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/plan.md', content: created.content.replace('v1', 'v2'), label: 'Board' },
    })
    expect(edited).toEqual({
      status: 'committed',
      oid: expect.any(String),
      blobOid: expect.any(String),
    })
    await json('PUT', url('team', 'file'), {
      json: {
        path: 'docs/plan.md',
        content: created.content.replace('v1', 'v3'),
        message: 'Tidy the plan',
      },
    })
    const history = await json('GET', url('team', 'history', { path: 'docs/plan.md' }))
    expect(history.map((c: { message: string; label?: string }) => [c.message, c.label])).toEqual([
      ['Tidy the plan', undefined],
      ['docs: edit "Plan"', 'Board'],
      ['docs: create "Plan"', undefined],
    ])
  })

  it('keeps the existing id when a save drops it, and rejects unpatchable frontmatter', async () => {
    const created = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/keep.md', content: '# Keep\n' },
    })
    const id = /id: (\w+)/.exec(created.content)?.[1]
    const resaved = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/keep.md', content: '# Keep\n\nNo frontmatter now.\n' },
    })
    expect(resaved.content).toBe(`---\nid: ${id}\n---\n# Keep\n\nNo frontmatter now.\n`)
    const bad = await json(
      'PUT',
      url('team', 'file'),
      { json: { path: 'docs/bad.md', content: '---\n{ title: x }\n---\n# Bad\n' } },
      400,
    )
    expect(bad.error.code).toBe('bad_request')
  })

  it('refuses to change the space’s ownership record', async () => {
    const body = await json(
      'PUT',
      url('team', 'file'),
      { json: { path: '.hearth/space.yaml', content: 'name: team\nschema: 1\nkind: team\n' } },
      403,
    )
    expect(body.error.code).toBe('forbidden')
    await json('DELETE', url('team', 'file'), { json: { path: '.hearth' } }, 403)
  })

  it('merges a stale save with an outside change, returning the merged content', async () => {
    const created = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/m.md', content: '# M\n\nAlpha: original\n\nmiddle\n\nOmega: original\n' },
    })
    const editor = await outside('team')
    const theirs = created.content.replace('Alpha: original', 'Alpha: outside')
    await editor.push({ 'docs/m.md': theirs })

    const result = await json('PUT', url('team', 'file'), {
      json: {
        path: 'docs/m.md',
        content: created.content.replace('Omega: original', 'Omega: mine'),
        baseBlobOid: created.blobOid,
      },
    })
    expect(result.status).toBe('merged')
    expect(result.content).toContain('Alpha: outside')
    expect(result.content).toContain('Omega: mine')
    expect((await json('GET', url('team', 'file', { path: 'docs/m.md' }))).content).toBe(
      result.content,
    )
  })

  it('answers overlapping edits with 409, lists the conflict, and resolving clears it', async () => {
    const created = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/c.md', content: '# C\n\nAlpha: original\n' },
    })
    const editor = await outside('team')
    await editor.push({ 'docs/c.md': created.content.replace('original', 'theirs') })

    const mine = created.content.replace('original', 'mine')
    const conflict = await json(
      'PUT',
      url('team', 'file'),
      { json: { path: 'docs/c.md', content: mine, baseBlobOid: created.blobOid } },
      409,
    )
    expect(conflict).toMatchObject({
      status: 'conflict',
      conflictRef: expect.stringMatching(/^refs\/heads\/conflicts\//),
      ours: { content: mine },
      theirs: { content: expect.stringContaining('Alpha: theirs') },
    })
    const listed = await json('GET', url('team', 'conflicts'))
    expect(listed).toEqual([
      { ref: conflict.conflictRef, path: 'docs/c.md', createdAt: expect.any(String) },
    ])
    expect(services.index.listConflicts('team').map((c) => c.ref)).toEqual([conflict.conflictRef])

    const detail = await json('GET', url('team', 'conflict', { ref: conflict.conflictRef }))
    expect(detail).toEqual({
      path: 'docs/c.md',
      ours: { content: mine },
      theirs: { content: expect.stringContaining('Alpha: theirs'), blobOid: expect.any(String) },
    })

    const resolved = await json('POST', url('team', 'conflict/resolve'), {
      json: { ref: conflict.conflictRef, content: mine },
    })
    expect(resolved.status).toBe('committed')
    expect(await json('GET', url('team', 'conflicts'))).toEqual([])
    expect(services.index.listConflicts('team')).toEqual([])
    expect((await json('GET', url('team', 'file', { path: 'docs/c.md' }))).content).toBe(mine)
    await json('GET', url('team', 'conflict', { ref: conflict.conflictRef }), {}, 404)
  })

  it('delete moves to .trash/<date>/<path>, twice in a day without colliding', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await json('PUT', url('team', 'file'), { json: { path: 'docs/gone.md', content: '# Gone\n' } })
    const { oid } = await json('DELETE', url('team', 'file'), { json: { path: 'docs/gone.md' } })
    expect(oid).toBe(await services.git.headOid('team'))
    await json('GET', url('team', 'file', { path: 'docs/gone.md' }), {}, 404)
    await json('GET', url('team', 'file', { path: `.trash/${day}/docs/gone.md` }))

    await json('PUT', url('team', 'file'), { json: { path: 'docs/gone.md', content: '# Again\n' } })
    await json('DELETE', url('team', 'file'), { json: { path: 'docs/gone.md' } })
    const days = (await json('GET', url('team', 'tree', { dir: '.trash' }))).map(
      (e: { path: string }) => e.path,
    )
    const again = days.find((p: string) => new RegExp(`^\\.trash/${day}-[0-9A-Z]{8}$`).test(p))
    expect(again).toBeDefined()
    expect(
      (await json('GET', url('team', 'file', { path: `.trash/${day}/docs/gone.md` }))).content,
    ).toContain('# Gone\n')
    expect(
      (await json('GET', url('team', 'file', { path: `${again}/docs/gone.md` }))).content,
    ).toContain('# Again\n')
    expect(services.index.getFile('team', 'docs/gone.md')).toBeNull()
  })

  it('deleting a folder moves the whole folder to the trash in one commit', async () => {
    const day = new Date().toISOString().slice(0, 10)
    await json('PUT', url('team', 'file'), { json: { path: 'docs/old/a.md', content: '# A\n' } })
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/old/deeper/b.md', content: '# B\n' },
    })
    const before = await services.git.headOid('team')

    const { oid } = await json('DELETE', url('team', 'file'), { json: { path: 'docs/old' } })

    expect(oid).toBe(await services.git.headOid('team'))
    const commits = await json('GET', url('team', 'history', { limit: '5' }))
    expect(commits[1].oid).toBe(before)
    expect(await json('GET', url('team', 'tree', { dir: 'docs/old' }))).toEqual([])
    await json('GET', url('team', 'file', { path: `.trash/${day}/docs/old/a.md` }))
    await json('GET', url('team', 'file', { path: `.trash/${day}/docs/old/deeper/b.md` }))
    expect(services.index.getFile('team', 'docs/old/a.md')).toBeNull()
    expect(services.index.getFile('team', 'docs/old/deeper/b.md')).toBeNull()

    // The same folder again that day goes to a second day folder, not into the first.
    await json('PUT', url('team', 'file'), { json: { path: 'docs/old/c.md', content: '# C\n' } })
    await json('DELETE', url('team', 'file'), { json: { path: 'docs/old' } })
    const firstOld = (
      await json('GET', url('team', 'tree', { dir: `.trash/${day}/docs/old` }))
    ).map((e: { path: string }) => e.path)
    expect(firstOld).not.toContain(`.trash/${day}/docs/old/c.md`)
    const days = (await json('GET', url('team', 'tree', { dir: '.trash' }))).map(
      (e: { path: string }) => e.path,
    )
    const again = days.find((p: string) => new RegExp(`^\\.trash/${day}-[0-9A-Z]{8}$`).test(p))
    await json('GET', url('team', 'file', { path: `${again}/docs/old/c.md` }))
  })

  it('move rewrites links into the moved doc, in the same commit as the move', async () => {
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/alpha.md', content: '# Alpha\n\nSee [the beta doc](beta.md).\n' },
    })
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/beta.md', content: '# Beta\n\nBack to [alpha](alpha.md).\n' },
    })

    const { oid } = await json('POST', url('team', 'move'), {
      json: { from: 'docs/beta.md', to: 'docs/archive/beta.md' },
    })

    const alpha = await json('GET', url('team', 'file', { path: 'docs/alpha.md' }))
    expect(alpha.content).toContain('See [the beta doc](archive/beta.md).')
    const beta = await json('GET', url('team', 'file', { path: 'docs/archive/beta.md' }))
    expect(beta.content).toContain('Back to [alpha](../alpha.md).')
    const [latest] = await json('GET', url('team', 'history', { path: 'docs/alpha.md' }))
    expect(latest.oid).toBe(oid)
    expect(latest.author.email).toBe(ALICE)
    expect(services.index.getFile('team', 'docs/archive/beta.md')?.title).toBe('Beta')
    expect(services.index.getFile('team', 'docs/beta.md')).toBeNull()
  })

  it('moving or deleting a meeting note carries its transcript in the same commit', async () => {
    const note =
      '---\ntype: meeting\ntitle: Acme sync\ntranscript: acme.transcript.md\n---\n# Acme sync\n'
    const transcript = '# Transcript\n\n[00:00:01] **Me:** hello\n'
    await json('PUT', url('alice', 'file'), { json: { path: 'meetings/acme.md', content: note } })
    const saved = await json('PUT', url('alice', 'file'), {
      json: { path: 'meetings/acme.transcript.md', content: transcript },
    })

    const { oid } = await json('POST', url('alice', 'move'), {
      json: { from: 'meetings/acme.md', to: 'meetings/clients/acme.md' },
    })

    const moved = await json(
      'GET',
      url('alice', 'file', { path: 'meetings/clients/acme.transcript.md' }),
    )
    expect(moved.content).toBe(saved.content)
    await json('GET', url('alice', 'file', { path: 'meetings/acme.transcript.md' }), {}, 404)
    const [latest] = await json(
      'GET',
      url('alice', 'history', { path: 'meetings/clients/acme.transcript.md' }),
    )
    expect(latest.oid).toBe(oid)

    const day = new Date().toISOString().slice(0, 10)
    await json('DELETE', url('alice', 'file'), { json: { path: 'meetings/clients/acme.md' } })
    await json(
      'GET',
      url('alice', 'file', { path: 'meetings/clients/acme.transcript.md' }),
      {},
      404,
    )
    const trashed = await json(
      'GET',
      url('alice', 'file', {
        path: `.trash/${day}/meetings/clients/acme.transcript.md`,
      }),
    )
    expect(trashed.content).toBe(saved.content)

    // A meeting with the same name, recorded and deleted again that day, goes to the trash too.
    await json('PUT', url('alice', 'file'), {
      json: { path: 'meetings/clients/acme.md', content: note },
    })
    await json('PUT', url('alice', 'file'), {
      json: { path: 'meetings/clients/acme.transcript.md', content: transcript },
    })
    await json('DELETE', url('alice', 'file'), { json: { path: 'meetings/clients/acme.md' } })
    const days = (await json('GET', url('alice', 'tree', { dir: '.trash' }))).map(
      (e: { path: string }) => e.path,
    )
    const again = days.find((p: string) => new RegExp(`^\\.trash/${day}-[0-9A-Z]{8}$`).test(p))
    await json('GET', url('alice', 'file', { path: `${again}/meetings/clients/acme.md` }))
    await json(
      'GET',
      url('alice', 'file', { path: `${again}/meetings/clients/acme.transcript.md` }),
    )
  })

  it('moving a folder rewrites links into it and keeps links between its files', async () => {
    const index = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/index.md', content: '# Index\n\nThe [plan](projects/plan.md).\n' },
    })
    const plan = await json('PUT', url('team', 'file'), {
      json: {
        path: 'docs/projects/plan.md',
        content: '# Plan\n\n[spec](spec.md) [up](../index.md)\n',
      },
    })
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/projects/spec.md', content: '# Spec\n' },
    })

    await json('POST', url('team', 'move'), {
      json: { from: 'docs/projects', to: 'docs/archive/projects' },
    })

    const moved = await json('GET', url('team', 'file', { path: 'docs/archive/projects/plan.md' }))
    expect(moved.content).toBe(plan.content.replace('../index.md', '../../index.md'))
    const outside = await json('GET', url('team', 'file', { path: 'docs/index.md' }))
    expect(outside.content).toBe(
      index.content.replace('projects/plan.md', 'archive/projects/plan.md'),
    )
  })

  it('shares a personal doc to the team: gone from personal, present in team', async () => {
    await json('PUT', url('alice', 'file'), {
      json: { path: 'docs/idea.md', content: '# Idea\n\nFor the team.\n' },
    })
    const { teamPath } = await json('POST', url('alice', 'share-to-team'), {
      json: { path: 'docs/idea.md', toFolder: 'docs/shared' },
    })
    expect(teamPath).toBe('docs/shared/idea.md')
    expect((await json('GET', url('team', 'file', { path: teamPath }))).content).toContain('# Idea')
    await json('GET', url('alice', 'file', { path: 'docs/idea.md' }), {}, 404)
    expect(services.index.getFile('team', teamPath)?.title).toBe('Idea')
    expect(services.index.getFile('alice', 'docs/idea.md')).toBeNull()

    await json(
      'POST',
      url('team', 'share-to-team'),
      { json: { path: teamPath, toFolder: '' } },
      400,
    )
    await json(
      'POST',
      url('alice', 'share-to-team'),
      { as: BOB, json: { path: 'docs/x.md', toFolder: 'docs' } },
      403,
    )
  })

  it('creates a folder with a .gitkeep', async () => {
    const { oid } = await json('POST', url('team', 'folder'), { json: { path: 'docs/projects' } })
    expect(oid).toBe(await services.git.headOid('team'))
    const docs = await json('GET', url('team', 'tree', { dir: 'docs' }))
    expect(docs).toContainEqual(expect.objectContaining({ path: 'docs/projects', type: 'dir' }))
  })
})

describe('history', () => {
  it('lists, shows, diffs and restores versions', async () => {
    const v1 = await json('PUT', url('team', 'file'), {
      json: { path: 'docs/h.md', content: '# History\n\nfirst\n' },
    })
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/h.md', content: v1.content.replace('first', 'second') },
    })
    const history = await json('GET', url('team', 'history', { path: 'docs/h.md' }))
    expect(history).toHaveLength(2)
    const [second, first] = history
    expect(first.oid).toBe(v1.oid)

    const shown = await json('GET', url('team', 'show', { oid: first.oid, path: 'docs/h.md' }))
    expect(shown).toEqual({ content: v1.content })
    const { diff } = await json(
      'GET',
      url('team', 'diff', { from: first.oid, to: second.oid, path: 'docs/h.md' }),
    )
    expect(diff).toContain('-first')
    expect(diff).toContain('+second')

    const restored = await json('POST', url('team', 'restore'), {
      json: { oid: first.oid, path: 'docs/h.md' },
    })
    expect(restored.status).toBe('committed')
    expect((await json('GET', url('team', 'file', { path: 'docs/h.md' }))).content).toBe(v1.content)
    const [latest] = await json('GET', url('team', 'history', { path: 'docs/h.md', limit: '1' }))
    expect(latest.message).toBe(`docs: restore "History" to ${first.oid.slice(0, 7)}`)
  })
})

describe('assets', () => {
  // A 1x1 PNG.
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  function upload(bytes: Uint8Array<ArrayBuffer>, name = 'Pixel Shot.png'): Promise<Response> {
    const form = new FormData()
    form.append('file', new File([bytes], name, { type: 'image/png' }))
    return call('POST', url('team', 'assets'), { as: ALICE, body: form })
  }

  it('uploads into assets/YYYY/MM and serves the bytes with an ETag to revalidate', async () => {
    const res = await upload(new Uint8Array(PIXEL))
    expect(res.status).toBe(200)
    const { path } = (await res.json()) as { path: string }
    expect(path).toMatch(/^assets\/\d{4}\/\d{2}\/pixel-shot-[0-9A-Z]{8}\.png$/)
    const [commit] = await json('GET', url('team', 'history', { path, limit: '1' }))
    expect(commit.message).toBe('docs: add asset "Pixel Shot.png"')

    const raw = await call('GET', url('team', 'raw', { path }), { as: ALICE })
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    // The URL names a path, whose bytes can change: the browser must ask again every time.
    expect(raw.headers.get('cache-control')).toBe('private, no-cache')
    const etag = raw.headers.get('etag')
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/)
    expect(Buffer.from(await raw.arrayBuffer()).equals(PIXEL)).toBe(true)

    const cached = await call('GET', url('team', 'raw', { path }), {
      as: ALICE,
      headers: { 'if-none-match': etag ?? '' },
    })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('cache-control')).toBe('private, no-cache')
  })

  it('refuses files over 10 MB with 413', async () => {
    const res = await upload(new Uint8Array(10 * 1024 * 1024 + 1))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request')
  })

  it('restores an old version of a binary file byte for byte', async () => {
    const { path } = (await (await upload(new Uint8Array(PIXEL))).json()) as { path: string }
    const [original] = await json('GET', url('team', 'history', { path, limit: '1' }))
    await services.git.commit('team', {
      changes: [{ path, content: Uint8Array.from([1, 2, 3]) }],
      author: { name: 'Alice', email: ALICE },
      message: 'docs: replace the pixel',
    })

    const restored = await json('POST', url('team', 'restore'), {
      json: { oid: original.oid, path },
    })

    expect(restored).toEqual({
      status: 'committed',
      oid: expect.any(String),
      blobOid: expect.any(String),
    })
    const raw = await call('GET', url('team', 'raw', { path }), { as: ALICE })
    expect(Buffer.from(await raw.arrayBuffer()).equals(PIXEL)).toBe(true)
    const [latest] = await json('GET', url('team', 'history', { path, limit: '1' }))
    const name = path.slice(path.lastIndexOf('/') + 1)
    expect(latest.message).toBe(`docs: restore "${name}" to ${original.oid.slice(0, 7)}`)
  })

  it('serves files a browser could run as downloads', async () => {
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/page.html', content: '<script>' },
    })
    const raw = await call('GET', url('team', 'raw', { path: 'docs/page.html' }), { as: ALICE })
    expect(raw.headers.get('content-type')).toBe('application/octet-stream')
    expect(raw.headers.get('content-disposition')).toBe('attachment')
    expect(raw.headers.get('content-security-policy')).toContain('sandbox')
  })
})

describe('search', () => {
  it('finds docs by title and by body, with snippet markers, only in accessible spaces', async () => {
    await json('PUT', url('team', 'file'), {
      json: { path: 'docs/kiln.md', content: '# Kiln schedule\n\nThe celadon batch cracked.\n' },
    })
    await json('PUT', url('alice', 'file'), {
      json: { path: 'docs/secret.md', content: '# Celadon secrets\n' },
    })

    const byTitle = await json('GET', '/api/search?q=kiln')
    expect(byTitle).toEqual([
      expect.objectContaining({ space: 'team', path: 'docs/kiln.md', title: 'Kiln schedule' }),
    ])
    const byBody = await json('GET', '/api/search?q=celadon')
    expect(byBody.map((h: { space: string }) => h.space).sort()).toEqual(['alice', 'team'])
    const teamHit = byBody.find((h: { space: string }) => h.space === 'team')
    expect(teamHit.snippet).toContain(`${SNIPPET_OPEN}celadon${SNIPPET_CLOSE}`)

    const asBob = await json('GET', '/api/search?q=celadon&spaces=alice,team', { as: BOB })
    expect(asBob.map((h: { space: string }) => h.space)).toEqual(['team'])
  })
})

describe('recents and stars', () => {
  it('records and lists them per member, only for spaces they can access', async () => {
    await json('PUT', url('team', 'file'), { json: { path: 'docs/r.md', content: '# Recent\n' } })
    await json('POST', '/api/recents', { json: { space: 'team', path: 'docs/r.md' } })
    expect(await json('GET', '/api/recents')).toEqual([
      { space: 'team', path: 'docs/r.md', title: 'Recent', openedAt: expect.any(String) },
    ])
    expect(await json('GET', '/api/recents', { as: BOB })).toEqual([])

    await json('POST', '/api/stars', { json: { space: 'team', path: 'docs/r.md', starred: true } })
    expect(await json('GET', '/api/stars')).toEqual([
      { space: 'team', path: 'docs/r.md', title: 'Recent' },
    ])
    await json('POST', '/api/stars', { json: { space: 'team', path: 'docs/r.md', starred: false } })
    expect(await json('GET', '/api/stars')).toEqual([])

    await json('GET', '/api/me') // provisions alice
    await json('POST', '/api/recents', { as: BOB, json: { space: 'alice', path: 'x.md' } }, 403)
  })
})

describe('rail pins', () => {
  it('starts empty, saves each member their own order, and refuses bad lists', async () => {
    expect(await json('GET', '/api/pins')).toEqual({ pins: null })
    const pins = ['tasks', 'today', 'chat']
    expect(await json('PUT', '/api/pins', { json: { pins } })).toEqual({ pins })
    expect(await json('GET', '/api/pins')).toEqual({ pins })
    expect(await json('GET', '/api/pins', { as: BOB })).toEqual({ pins: null })

    await json('PUT', '/api/pins', { json: { pins: [] } })
    expect(await json('GET', '/api/pins')).toEqual({ pins: [] })

    const tooMany = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    await json('PUT', '/api/pins', { json: { pins: tooMany } }, 400)
    await json('PUT', '/api/pins', { json: { pins: ['docs', 'docs'] } }, 400)
    await json('PUT', '/api/pins', { json: { pins: ['../etc'] } }, 400)
    expect(await json('GET', '/api/pins')).toEqual({ pins: [] })
  })
})

describe('webhooks', () => {
  function signedPush(body: string, secret = WEBHOOK_SECRET): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-forgejo-event': 'push',
      'x-forgejo-signature': createHmac('sha256', secret).update(body).digest('hex'),
    }
  }

  it('rejects a bad signature with 401', async () => {
    const res = await call('POST', '/api/webhooks/git', {
      body: '{"ref":"refs/heads/main","repository":{"name":"team"}}',
      headers: { 'x-forgejo-event': 'push', 'x-forgejo-signature': 'f'.repeat(64) },
    })
    expect(res.status).toBe(401)
  })

  it('answers 401 to an unsigned request without reading its body', async () => {
    let read = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true
          controller.enqueue(new TextEncoder().encode('{}'))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    // A streamed body needs `duplex`, which the DOM typings don't know about.
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
    const res = await app.request(new Request('http://localhost/api/webhooks/git', init))
    expect(res.status).toBe(401)
    expect(read).toBe(false)
  })

  it('refuses a signed body over 5 MB with 413', async () => {
    const body = 'x'.repeat(5 * 1024 * 1024 + 1)
    const res = await call('POST', '/api/webhooks/git', { body, headers: signedPush(body) })
    expect(res.status).toBe(413)
  })

  it('syncs a known space on a signed push, and ignores unknown repos', async () => {
    // LocalHost has no webhooks; borrow Forgejo's signature check, keep the local remotes.
    const forgejo = new ForgejoHost({ url: 'http://forgejo.invalid', token: 'x', org: 'hearth' })
    services.host.parseWebhook = (headers, body, secret) =>
      forgejo.parseWebhook(headers, body, secret)
    const editor = await outside('team')
    await editor.push({ 'docs/pushed.md': '# Pushed from outside\n' })

    const unknown = '{"ref":"refs/heads/main","repository":{"name":"elsewhere"}}'
    const ignored = await call('POST', '/api/webhooks/git', {
      body: unknown,
      headers: signedPush(unknown),
    })
    expect(ignored.status).toBe(204)
    expect(services.index.getFile('team', 'docs/pushed.md')).toBeNull()

    const body = '{"ref":"refs/heads/main","repository":{"name":"team"}}'
    const res = await call('POST', '/api/webhooks/git', { body, headers: signedPush(body) })
    expect(res.status).toBe(204)
    expect(services.index.getFile('team', 'docs/pushed.md')?.title).toBe('Pushed from outside')
    const remote = join(root, 'remotes', 'team.git')
    expect((await runGit(remote, ['rev-parse', 'main'])).trim()).toBe(
      await services.git.headOid('team'),
    )
  })
})
