import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writablePath } from '../../src/api/save.js'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakePushSender } from '../../src/meetings/reminders/sender.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Comments and @mentions (docs/PLAN-comments.md R1–R11; ARCHITECTURE §27) through the API with
// dev auth and a fake push sender.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const ADMIN = 'admin@example.test'
const DOC = 'docs/pilot-plan.md'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let push: FakePushSender

beforeEach(async () => {
  root = await makeTempDir('hotsauce-comments-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://hotsauce.example.test',
  })
  push = new FakePushSender()
  services = createServices(config, { pushSender: push })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  // Everyone signs in once, so each has a personal space and can be mentioned.
  for (const who of [ALICE, BOB, ADMIN]) await api('GET', '/api/me', { as: who })
  await write('team', DOC, '# Pilot plan\n\nThe budget is in section two.\n')
})

afterEach(async () => {
  await services.comments.idle()
  await services.checkinScheduler.close()
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, path: string, opts: { as?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; status?: number } = {},
): Promise<T> {
  const res = await call(method, path, opts)
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

const write = (space: string, path: string, content: string, as = ALICE) =>
  api('PUT', `/api/spaces/${space}/file`, { as, json: { path, content } })

const listOf = (path: string, as = ALICE, space = 'team') =>
  api('GET', `/api/comments?space=${space}&path=${encodeURIComponent(path)}`, { as })

const comment = (path: string, text: string, as = ALICE, extra: Record<string, unknown> = {}) =>
  api('POST', '/api/comments', {
    as,
    json: { space: 'team', path, text, ...extra },
    status: 201,
  })

/** A browser that turned notifications on, as `email`. */
async function subscribe(email: string): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${email.split('@')[0]}`
  const me = await api('GET', '/api/me', { as: email })
  await services.meetings.reminderStore.subscribe(me.principal, {
    endpoint,
    keys: { p256dh: 'p', auth: 'a' },
  })
  return endpoint
}

async function teamFiles(): Promise<string[]> {
  const dir = join(root, 'data', 'repos', 'team')
  return (await runGit(dir, ['ls-files'])).split('\n').filter(Boolean)
}

async function teamLog(): Promise<string> {
  return runGit(join(root, 'data', 'repos', 'team'), ['log', '--format=%an <%ae>|%s'])
}

describe('a conversation under a team item (R1, R2, R3, R11)', () => {
  it('a member comments on a doc; it shows with their name, oldest first, and survives a reindex', async () => {
    expect(await listOf(DOC)).toEqual({ canComment: true, comments: [] })
    const first = await comment(DOC, 'Can we trim the budget?')
    const second = await comment(DOC, 'Yes, see section two.', BOB)
    expect(first).toMatchObject({
      author: ALICE,
      name: 'Alice',
      text: 'Can we trim the budget?',
      edited: null,
      quote: null,
      mine: true,
    })
    expect(Date.parse(first.created)).not.toBeNaN()
    const before = await listOf(DOC, BOB)
    expect(before.comments.map((c: { text: string }) => c.text)).toEqual([
      'Can we trim the budget?',
      'Yes, see section two.',
    ])
    expect(before.comments.map((c: { mine: boolean }) => c.mine)).toEqual([false, true])

    // One file per comment, in the team space, authored by the member.
    const files = (await teamFiles()).filter((f) => f.startsWith('.hearth/comments/'))
    expect(files).toEqual([
      `.hearth/comments/${first.item}/${first.id}.md`,
      `.hearth/comments/${first.item}/${second.id}.md`,
    ])
    expect(await teamLog()).toContain('Alice <alice@example.test>|comments: add to "Pilot plan"')

    // The index is a cache: from an empty one, the conversation is read back out of Git.
    services.index.reindexSpace('team', [])
    expect((await listOf(DOC)).comments).toEqual([])
    await services.indexer.full('team')
    expect(await listOf(DOC, BOB)).toEqual(before)
  })

  it('works the same under a meeting note and a task', async () => {
    await write(
      'team',
      'meetings/2026/11/2026-11-16-standup.md',
      '---\nid: 01JCZZZZZZZZZZZZZZZZZZZZZZ\ntype: meeting\ntitle: Standup\ndate: 2026-11-16\n---\n# Standup\n',
    )
    await comment('meetings/2026/11/2026-11-16-standup.md', 'Who took the action item?')
    const note = await listOf('meetings/2026/11/2026-11-16-standup.md')
    expect(note.comments).toHaveLength(1)
    expect(note.comments[0].item).toBe('01JCZZZZZZZZZZZZZZZZZZZZZZ')

    const task = await api('POST', '/api/tasks', {
      json: { title: 'Order pipette tips', space: 'team' },
      status: 201,
    })
    await comment(task.path, 'Ordered, arriving Friday.', BOB)
    const under = await listOf(task.path)
    expect(under.comments).toMatchObject([{ item: task.id, text: 'Ordered, arriving Friday.' }])
  })

  it('a personal item has no comment box and the API refuses a comment on it', async () => {
    const me = await api('GET', '/api/me')
    const personal = me.spaces.find((s: { kind: string }) => s.kind === 'personal').name
    await write(personal, 'docs/private.md', '# Private\n')
    expect(await listOf('docs/private.md', ALICE, personal)).toEqual({
      canComment: false,
      comments: [],
    })
    const res = await call('POST', '/api/comments', {
      json: { space: personal, path: 'docs/private.md', text: 'hello' },
    })
    expect(res.status).toBe(403)
    expect((await teamFiles()).some((f) => f.startsWith('.hearth/comments/'))).toBe(false)
  })

  it('refuses an empty comment, one that is too long, and an item that isn’t saved', async () => {
    await api('POST', '/api/comments', {
      json: { space: 'team', path: DOC, text: '  ' },
      status: 400,
    })
    await api('POST', '/api/comments', {
      json: { space: 'team', path: DOC, text: 'x'.repeat(10_001) },
      status: 400,
    })
    await api('POST', '/api/comments', {
      json: { space: 'team', path: 'docs/nowhere.md', text: 'hi' },
      status: 404,
    })
  })

  it('two members commenting at the same moment both succeed, in order', async () => {
    const both = await Promise.all([
      comment(DOC, 'From Alice'),
      comment(DOC, 'From Bob', BOB),
      comment(DOC, 'From the admin', ADMIN),
    ])
    const { comments } = await listOf(DOC)
    expect(comments).toHaveLength(3)
    expect(new Set(comments.map((c: { id: string }) => c.id))).toEqual(
      new Set(both.map((c) => c.id)),
    )
    const created = comments.map((c: { created: string }) => c.created)
    expect(created).toEqual([...created].sort())
  })

  it('first comments at the same moment on a doc with no id both succeed, under one id', async () => {
    await services.git.commit('team', {
      changes: [{ path: 'docs/outside.md', content: '# Outside\n\nNo id here.\n' }],
      author: { name: 'Outside', email: 'outside@example.test' },
      message: 'add a doc with no id',
    })
    await services.syncer.afterHeadChanged('team')
    const made = await Promise.all([
      comment('docs/outside.md', 'From Alice'),
      comment('docs/outside.md', 'From Bob', BOB),
      comment('docs/outside.md', 'From the admin', ADMIN),
    ])
    expect(new Set(made.map((c) => c.item)).size).toBe(1)
    expect((await listOf('docs/outside.md')).comments).toHaveLength(3)
    const text = (await services.git.readFile('team', 'docs/outside.md')).content
    expect(text.match(/^id: /gm)).toHaveLength(1)
  })

  it('refuses a comment on something hidden or in the trash', async () => {
    await comment(DOC, 'Before it goes')
    await api('DELETE', '/api/spaces/team/file', { json: { path: DOC } })
    const trashed = (await teamFiles()).find((f) => f.startsWith('.trash/') && f.endsWith('.md'))
    expect(trashed).toBeDefined()
    for (const path of [trashed as string, '.hearth/notes.md']) {
      const res = await call('POST', '/api/comments', {
        json: { space: 'team', path, text: 'Sneaky' },
      })
      expect(res.status, path).toBe(400)
      expect((await listOf(path)).canComment).toBe(false)
    }
  })

  it('only the Comments service writes comment files', async () => {
    const made = await comment(DOC, 'Hello')
    const path = `.hearth/comments/${made.item}/${made.id}.md`
    expect(() => writablePath(path)).toThrow(/Comments change only/)
    expect(() => writablePath('.hearth/comments')).toThrow()
    await api('PUT', '/api/spaces/team/file', { json: { path, content: 'x' }, status: 403 })
    await api('DELETE', '/api/spaces/team/file', { json: { path }, status: 403 })
  })

  it('comments stay out of search until they are asked for', async () => {
    await comment(DOC, 'The zebrafish shipment is late')
    const hits = await api('GET', '/api/search?q=zebrafish')
    expect(JSON.stringify(hits)).not.toContain('.hearth/comments')
    expect(
      services.index.search('zebrafish', { spaces: ['team'], kinds: ['comment'] }),
    ).toHaveLength(1)
  })

  it('an item with 200 comments lists from the index, quickly', async () => {
    const first = await comment(DOC, 'Comment 0')
    // The rest go straight into Git, the way a sync from another machine would bring them.
    const changes = Array.from({ length: 199 }, (_, i) => {
      const id = `01JD${String(i + 1).padStart(22, '0')}`
      const created = new Date(Date.parse(first.created) + (i + 1) * 1000).toISOString()
      return {
        path: `.hearth/comments/${first.item}/${id}.md`,
        content: `---\nid: ${id}\ntype: comment\nitem: ${first.item}\nauthor: ${BOB}\nname: Bob\ncreated: ${created}\nmentions: []\n---\nComment ${i + 1}\n`,
      }
    })
    await services.git.commit('team', {
      changes,
      author: { name: 'Bob', email: BOB },
      message: 'comments: seed',
    })
    await services.syncer.afterHeadChanged('team')
    const started = performance.now()
    const { comments } = await listOf(DOC)
    const took = performance.now() - started
    expect(comments).toHaveLength(200)
    expect(comments[0].text).toBe('Comment 0')
    expect(comments[199].text).toBe('Comment 199')
    expect(took).toBeLessThan(500)
  })
})

describe('@mentions and the push (R4, R5, R7)', () => {
  it('offers members by name', async () => {
    const { members } = await api('GET', '/api/comments/members')
    expect(members).toEqual([
      { email: ADMIN, name: 'Admin', handle: 'admin' },
      { email: ALICE, name: 'Alice', handle: 'alice' },
      { email: BOB, name: 'Bob', handle: 'bob' },
    ])
  })

  it('stores the members a comment names; a non-member stays plain text', async () => {
    const made = await comment(DOC, '@Bob and @Grace Hopper, can you check the budget?')
    expect(made.mentions).toEqual([{ email: BOB, name: 'Bob' }])
    expect(made.text).toBe('@Bob and @Grace Hopper, can you check the budget?')
    const file = await services.git.readFile('team', `.hearth/comments/${made.item}/${made.id}.md`)
    expect(file.content).toContain(`mentions:\n  - ${BOB}\n`)
  })

  it('the mentioned member gets one push naming the author and the item; the author gets none', async () => {
    const bob = await subscribe(BOB)
    await subscribe(ALICE)
    const made = await comment(DOC, '@Bob can you check the budget section before Thursday? @Alice')
    await services.comments.idle()
    expect(push.sent).toEqual([
      {
        endpoint: bob,
        payload: {
          title: 'Alice mentioned you',
          body: 'Pilot plan: @Bob can you check the budget section before Thursday? @Alice',
          url: `/docs/team/docs/pilot-plan.md#comment-${made.id}`,
          tag: `comment-${made.id}`,
        },
        ttlSeconds: 86_400,
      },
    ])
  })

  it('a push opens a task or a meeting note where it lives', async () => {
    await subscribe(BOB)
    const task = await api('POST', '/api/tasks', {
      json: { title: 'Order tips', space: 'team' },
      status: 201,
    })
    const made = await comment(task.path, '@Bob yours?')
    await services.comments.idle()
    expect(push.sent[0]?.payload.url).toBe(`/tasks/item/team/${task.id}#comment-${made.id}`)
    expect(push.sent[0]?.payload.body).toBe('Order tips: @Bob yours?')
  })

  it('a browser that dropped its subscription is forgotten, and a failing one doesn’t stop the comment', async () => {
    const bob = await subscribe(BOB)
    push.gone.add(bob)
    await comment(DOC, '@Bob one')
    await services.comments.idle()
    expect(await services.meetings.reminderStore.subscribers()).toEqual([])
    const again = await subscribe(BOB)
    push.failing.add(again)
    await comment(DOC, '@Bob two')
    await services.comments.idle()
    expect((await listOf(DOC)).comments).toHaveLength(2)
  })

  it('the author edits their comment (it shows edited) and deletes it; another member can’t; an admin can delete', async () => {
    const made = await comment(DOC, 'Frist draft')
    const at = `/api/comments/${made.item}/${made.id}`
    await api('PATCH', at, { as: BOB, json: { text: 'hijack' }, status: 403 })
    await api('DELETE', at, { as: BOB, status: 403 })
    const edited = await api('PATCH', at, { json: { text: 'First draft' } })
    expect(edited).toMatchObject({ id: made.id, text: 'First draft', created: made.created })
    expect(Date.parse(edited.edited)).not.toBeNaN()
    const seen = await listOf(DOC, BOB)
    expect(seen.comments).toMatchObject([{ text: 'First draft', canEdit: false, canDelete: false }])
    expect((await listOf(DOC, ADMIN)).comments[0]).toMatchObject({
      canEdit: false,
      canDelete: true,
    })

    await api('DELETE', at, { status: 204 })
    expect((await listOf(DOC)).comments).toEqual([])
    await api('PATCH', at, { json: { text: 'again' }, status: 404 })

    const other = await comment(DOC, 'Off topic', BOB)
    await api('DELETE', `/api/comments/${other.item}/${other.id}`, { as: ADMIN, status: 204 })
    expect((await listOf(DOC)).comments).toEqual([])
    expect(await teamLog()).toContain(
      'Admin <admin@example.test>|comments: delete from "Pilot plan"',
    )
  })

  it('an edit that adds a mention pushes only the newly named member', async () => {
    const bob = await subscribe(BOB)
    const admin = await subscribe(ADMIN)
    const made = await comment(DOC, '@Bob take a look')
    await services.comments.idle()
    expect(push.sent.map((s) => s.endpoint)).toEqual([bob])
    const edited = await api('PATCH', `/api/comments/${made.item}/${made.id}`, {
      json: { text: '@Bob and @Admin take a look' },
    })
    expect(edited.mentions.map((m: { email: string }) => m.email)).toEqual([BOB, ADMIN])
    await services.comments.idle()
    expect(push.sent.map((s) => s.endpoint)).toEqual([bob, admin])
    expect(push.sent[1]?.payload.title).toBe('Alice mentioned you')
  })
})

describe('quoting a passage (R6)', () => {
  it('keeps the quoted passage with the comment', async () => {
    const made = await comment(DOC, 'Is this still right?', ALICE, {
      quote: 'The budget is in section two.',
    })
    expect(made.quote).toBe('The budget is in section two.')
    expect((await listOf(DOC, BOB)).comments[0].quote).toBe('The budget is in section two.')
  })
})

describe('the conversation follows its item (R8, R9)', () => {
  it('moving or renaming the item keeps its conversation', async () => {
    await comment(DOC, 'Stays with the doc')
    await api('POST', '/api/spaces/team/move', {
      json: { from: DOC, to: 'docs/archive/pilot-2026.md' },
    })
    expect((await listOf(DOC)).comments).toEqual([])
    expect((await listOf('docs/archive/pilot-2026.md')).comments).toMatchObject([
      { text: 'Stays with the doc' },
    ])
  })

  it('deleting a doc removes its conversation, in the same commit', async () => {
    const made = await comment(DOC, 'Soon gone')
    await api('DELETE', '/api/spaces/team/file', { json: { path: DOC } })
    expect((await teamFiles()).filter((f) => f.startsWith('.hearth/comments/'))).toEqual([])
    const dir = join(root, 'data', 'repos', 'team')
    const last = await runGit(dir, ['show', '--name-status', '--format=', 'HEAD'])
    expect(last).toContain(`.hearth/comments/${made.item}/${made.id}.md`)
    expect(last).toContain('.trash/')
  })

  it('deleting a folder removes the conversations under everything in it', async () => {
    await write('team', 'docs/lab/a.md', '# A\n')
    await write('team', 'docs/lab/b.md', '# B\n')
    await comment('docs/lab/a.md', 'on a')
    await comment('docs/lab/b.md', 'on b')
    await comment(DOC, 'elsewhere')
    await api('DELETE', '/api/spaces/team/file', { json: { path: 'docs/lab' } })
    const left = (await teamFiles()).filter((f) => f.startsWith('.hearth/comments/'))
    expect(left).toHaveLength(1)
    expect((await listOf(DOC)).comments).toHaveLength(1)
  })

  it('deleting a task or a meeting note removes its conversation', async () => {
    const task = await api('POST', '/api/tasks', {
      json: { title: 'Tips', space: 'team' },
      status: 201,
    })
    await comment(task.path, 'on the task')
    await api('DELETE', `/api/tasks/team/${task.id}`, { status: 204 })

    const note = 'meetings/2026/11/2026-11-16-standup.md'
    await write(
      'team',
      note,
      '---\nid: 01JCZZZZZZZZZZZZZZZZZZZZZZ\ntype: meeting\ntitle: Standup\ndate: 2026-11-16\n---\n# Standup\n',
    )
    await comment(note, 'on the note')
    await api('POST', '/api/meetings/delete', { json: { space: 'team', path: note } })
    expect((await teamFiles()).filter((f) => f.startsWith('.hearth/comments/'))).toEqual([])
  })

  it('a team task moved to a personal space and back still has its conversation', async () => {
    const task = await api('POST', '/api/tasks', {
      json: { title: 'Order tips', space: 'team' },
      status: 201,
    })
    await comment(task.path, 'Which size?')
    const moved = await api('POST', `/api/tasks/team/${task.id}/move`, {
      json: { toSpace: 'alice' },
    })
    expect((await listOf(moved.path, ALICE, 'alice')).canComment).toBe(false)
    const back = await api('POST', `/api/tasks/alice/${task.id}/move`, {
      json: { toSpace: 'team' },
    })
    const { comments } = await listOf(back.path)
    expect(comments.map((c: { text: string }) => c.text)).toEqual(['Which size?'])
  })

  it('a copy of a doc shares its conversation, which stays until the last copy is deleted', async () => {
    const made = await comment(DOC, 'Kept while a copy lives')
    const original = (await services.git.readFile('team', DOC)).content
    expect(original).toContain(`id: ${made.item}`)
    await services.git.commit('team', {
      changes: [{ path: 'docs/pilot-plan-copy.md', content: original }],
      author: { name: 'Outside', email: 'outside@example.test' },
      message: 'copy the plan',
    })
    await services.syncer.afterHeadChanged('team')
    await api('DELETE', '/api/spaces/team/file', { json: { path: DOC } })
    expect((await listOf('docs/pilot-plan-copy.md')).comments).toHaveLength(1)
    await api('DELETE', '/api/spaces/team/file', { json: { path: 'docs/pilot-plan-copy.md' } })
    expect((await teamFiles()).filter((f) => f.startsWith('.hearth/comments/'))).toEqual([])
  })

  it('a doc with no id gets one on its first comment, and the rest of the file is unchanged', async () => {
    // Written outside Hotsauce: no frontmatter id, odd spacing, CRLF, no trailing newline.
    const original =
      '---\r\ntitle:   Field notes\r\ntags: [a,  b]\r\n---\r\n# Field notes\r\n\r\nSome  text'
    await services.git.commit('team', {
      changes: [{ path: 'docs/field-notes.md', content: original }],
      author: { name: 'Outside', email: 'outside@example.test' },
      message: 'add field notes',
    })
    await services.syncer.afterHeadChanged('team')
    const made = await comment('docs/field-notes.md', 'First!')
    const after = (await services.git.readFile('team', 'docs/field-notes.md')).content
    expect(after).toContain(`id: ${made.item}`)
    const withoutId = after
      .split('\r\n')
      .filter((line) => line !== `id: ${made.item}`)
      .join('\r\n')
    expect(withoutId).toBe(original)
    expect((await listOf('docs/field-notes.md')).comments).toHaveLength(1)
    // One commit carried both.
    const dir = join(root, 'data', 'repos', 'team')
    const last = await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])
    expect(last.split('\n').filter(Boolean).sort()).toEqual(
      [`.hearth/comments/${made.item}/${made.id}.md`, 'docs/field-notes.md'].sort(),
    )
    // The second comment adds nothing to the doc.
    await comment('docs/field-notes.md', 'Second')
    expect((await services.git.readFile('team', 'docs/field-notes.md')).content).toBe(after)
  })
})
