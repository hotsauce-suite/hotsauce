import { join } from 'node:path'
import { taskPath } from '@hearth/format'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import type {
  DictationTranscriber,
  TranscribeOptions,
  TranscribeResult,
} from '../../src/dictation/index.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, type LLMRequest, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import type { TaskView } from '../../src/tasks/index.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
// No daylight saving, so dates below don't depend on when the test runs.
const TZ = 'Asia/Kolkata'

/** A transcriber that says whatever the test sets. */
class ScriptedTranscriber implements DictationTranscriber {
  text = 'Call Sam tomorrow. Send the deck fri p1 #Board and then book flights'
  readonly calls: TranscribeOptions[] = []
  async transcribe(_audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    this.calls.push(opts)
    return { text: this.text, durationMs: 3000 }
  }
}

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let asr: ScriptedTranscriber
let respond: (req: LLMRequest) => string | Promise<string>
let todoist: {
  requests: Array<{ url: string; auth: string | null }>
  pages: Record<string, unknown[][]>
}

beforeEach(async () => {
  root = await makeTempDir('hearth-tasks-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  asr = new ScriptedTranscriber()
  respond = scriptedResponse
  todoist = { requests: [], pages: { projects: [[]], sections: [[]], tasks: [[]] } }
  services = createServices(config, {
    llm: new FakeLLM((req) => respond(req)),
    dictationTranscriber: asr,
    todoistFetch: fakeTodoist,
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  // Both members have signed in once, so each is a known member with a personal space.
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

/** Todoist's v1 API: `pages[endpoint][n]` is the n-th page; a cursor names the next. */
const fakeTodoist: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const headers = new Headers(init?.headers)
  todoist.requests.push({ url: url.href, auth: headers.get('authorization') })
  if (headers.get('authorization') !== 'Bearer good-token') {
    return new Response('{"error":"unauthorized"}', { status: 401 })
  }
  const endpoint = url.pathname.replace('/api/v1/', '')
  const pages = todoist.pages[endpoint] ?? [[]]
  const n = Number(url.searchParams.get('cursor') ?? 0)
  const next = n + 1 < pages.length ? String(n + 1) : null
  return Response.json({ results: pages[n] ?? [], next_cursor: next })
}

interface Options {
  as?: string
  token?: string
  json?: unknown
  body?: Uint8Array
  type?: string
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  if (opts.type) headers['content-type'] = opts.type
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
  return app.request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: body as BodyInit } : {}),
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

const bare = (space: string) => join(root, 'remotes', `${space}.git`)
/** `Author Name <email>|subject` of the newest commit on the host. */
const lastCommit = async (space: string) =>
  (await runGit(bare(space), ['log', '-1', '--format=%an <%ae>|%s', 'main'])).trim()
const readRemote = (space: string, path: string) => catFile(bare(space), 'main', path)
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

async function quick(text: string, opts: { as?: string; space?: string } = {}): Promise<TaskView> {
  return api('POST', '/api/tasks/quick', {
    as: opts.as ?? ALICE,
    json: { text, tz: TZ, ...(opts.space ? { space: opts.space } : {}) },
    status: 201,
  })
}

describe('writes', () => {
  it('creates, edits, completes, reopens, moves and deletes, each a commit by the member', async () => {
    const created = await api<TaskView>('POST', '/api/tasks', {
      json: { title: 'Write the plan', notes: 'First draft', priority: 2, tz: TZ },
      status: 201,
    })
    expect(created).toMatchObject({
      space: 'alice',
      path: taskPath(created.id),
      title: 'Write the plan',
      notes: 'First draft',
      priority: 2,
      status: 'open',
      createdBy: ALICE,
      mine: true,
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: create "Write the plan"`)
    const file = await readRemote('alice', created.path)
    expect(file).toContain('type: task\n')
    expect(file.endsWith('\nFirst draft\n')).toBe(true)

    const q = await quick('Call Sam tomorrow 3pm p1 #Ops @calls')
    expect(q).toMatchObject({
      title: 'Call Sam',
      due: `${addDays(today(), 1)}T15:00`,
      tz: TZ,
      dueAt: new Date(Date.parse(`${addDays(today(), 1)}T15:00:00+05:30`)).toISOString(),
      priority: 1,
      project: 'Ops',
      labels: ['calls'],
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: create "Call Sam"`)

    const edited = await api<TaskView>('PATCH', `/api/tasks/alice/${created.id}`, {
      json: { title: 'Write the real plan', project: 'Board', notes: 'Second draft' },
    })
    expect(edited).toMatchObject({
      title: 'Write the real plan',
      project: 'Board',
      notes: 'Second draft',
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: edit "Write the real plan"`)
    // Only the keys that changed were touched; the rest of the file is as Hearth wrote it.
    const after = await readRemote('alice', created.path)
    expect(after).toContain('priority: 2\n')
    expect(after.endsWith('\nSecond draft\n')).toBe(true)

    const done = await api<TaskView>('POST', `/api/tasks/alice/${created.id}/complete`, {
      json: { tz: TZ },
    })
    expect(done).toMatchObject({
      status: 'done',
      completedBy: ALICE,
      completed: expect.any(String),
    })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: complete "Write the real plan"`)

    const reopened = await api<TaskView>('POST', `/api/tasks/alice/${created.id}/reopen`)
    expect(reopened).toMatchObject({ status: 'open', completed: null, completedBy: null })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: reopen "Write the real plan"`)
    expect(await readRemote('alice', created.path)).not.toContain('completed')

    const moved = await api<TaskView>('POST', `/api/tasks/alice/${created.id}/move`, {
      json: { toSpace: 'team' },
    })
    expect(moved).toMatchObject({ space: 'team', id: created.id, title: 'Write the real plan' })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|tasks: move "Write the real plan"`)
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: move "Write the real plan"`)
    await api('GET', `/api/tasks/alice/${created.id}`, { status: 404 })
    expect(await api('GET', `/api/tasks/team/${created.id}`)).toMatchObject({
      notes: 'Second draft',
    })

    await api('DELETE', `/api/tasks/team/${created.id}`, { status: 204 })
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|tasks: delete "Write the real plan"`)
    await api('GET', `/api/tasks/team/${created.id}`, { status: 404 })
    const day = new Date().toISOString().slice(0, 10)
    expect(await readRemote('team', `.trash/${day}/${created.path}`)).toContain(
      'Write the real plan',
    )

    const listed = await api('GET', '/api/tasks?status=all')
    expect(listed.tasks.map((t: TaskView) => t.title)).toEqual(['Call Sam'])
  })

  it('moves a recurring task forward on completion, keeping its time', async () => {
    const t = await quick('Standup notes every weekday 9am')
    expect(t.recur).toBe('every weekday')
    const done = await api<TaskView>('POST', `/api/tasks/alice/${t.id}/complete`, {
      json: { tz: TZ },
    })
    expect(done.status).toBe('open')
    expect(done.due?.slice(10)).toBe('T09:00')
    expect(done.due && t.due && done.due > t.due).toBe(true)
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: complete "Standup notes"`)
  })

  it('refuses a stale title edit with baseBlobOid, but merges field patches', async () => {
    const t = await quick('Draft memo')
    await api('PATCH', `/api/tasks/alice/${t.id}`, { json: { title: 'Draft the memo' } })
    // A priority change on the old version is just a field patch.
    await api('PATCH', `/api/tasks/alice/${t.id}`, {
      json: { priority: 3, baseBlobOid: t.blobOid },
    })
    await api('PATCH', `/api/tasks/alice/${t.id}`, {
      json: { title: 'Draft memo v2', baseBlobOid: t.blobOid },
      status: 409,
    })
    expect(await api('GET', `/api/tasks/alice/${t.id}`)).toMatchObject({
      title: 'Draft the memo',
      priority: 3,
    })
  })

  it('validates input', async () => {
    await api('POST', '/api/tasks', { json: { title: '  ' }, status: 400 })
    await api('POST', '/api/tasks', { json: { title: 'x', due: '2026-02-30' }, status: 400 })
    await api('POST', '/api/tasks', { json: { title: 'x', recur: 'whenever' }, status: 400 })
    await api('POST', '/api/tasks/quick', { json: { text: 'x', tz: 'Mars/Base' }, status: 400 })
    await api('POST', '/api/tasks/quick', { json: { text: 'x +nobody', tz: TZ }, status: 400 })
    await api('GET', '/api/tasks/alice/not-an-id', { status: 404 })
    await api('GET', '/api/tasks/alice/01JD3Z6Q8W8Y5G2N4K7M9P0R1S', { status: 404 })
  })
})

describe('visibility', () => {
  it('keeps personal tasks to their owner, and shares team tasks', async () => {
    const mine = await quick('Private thing')
    const team = await quick('Team thing', { space: 'team' })
    const forBob = await quick('Review the deck +bob')
    expect(forBob).toMatchObject({ space: 'team', assignee: BOB, mine: false })

    const bobs = await api('GET', '/api/tasks?status=all', { as: BOB })
    expect(bobs.tasks.map((t: TaskView) => t.title).sort()).toEqual([
      'Review the deck',
      'Team thing',
    ])
    const bobMine = await api('GET', '/api/tasks?mine=true', { as: BOB })
    expect(bobMine.tasks.map((t: TaskView) => t.title)).toEqual(['Review the deck'])
    const aliceMine = await api('GET', '/api/tasks?mine=true')
    expect(aliceMine.tasks.map((t: TaskView) => t.title).sort()).toEqual([
      'Private thing',
      'Team thing',
    ])

    for (const [method, url, json] of [
      ['GET', `/api/tasks/alice/${mine.id}`, undefined],
      ['PATCH', `/api/tasks/alice/${mine.id}`, { title: 'x' }],
      ['POST', `/api/tasks/alice/${mine.id}/complete`, { tz: TZ }],
      ['POST', `/api/tasks/alice/${mine.id}/reopen`, undefined],
      ['POST', `/api/tasks/alice/${mine.id}/move`, { toSpace: 'team' }],
      ['DELETE', `/api/tasks/alice/${mine.id}`, undefined],
      ['GET', '/api/tasks?space=alice', undefined],
    ] as const) {
      await api(method, url, { as: BOB, ...(json ? { json } : {}), status: 403 })
    }
    await api('POST', '/api/tasks/quick', {
      as: BOB,
      json: { text: 'Sneak in', tz: TZ, space: 'alice' },
      status: 403,
    })
    expect((await api('GET', `/api/tasks/team/${team.id}`, { as: BOB })).mine).toBe(false)
  })

  it('refuses to assign a personal task to someone else', async () => {
    await api('POST', '/api/tasks', {
      json: { title: 'x', assignee: 'bob', space: 'alice' },
      status: 400,
    })
    const t = await quick('Mine for now')
    await api('PATCH', `/api/tasks/alice/${t.id}`, { json: { assignee: BOB }, status: 400 })
    // Assigning yourself is fine.
    await api('PATCH', `/api/tasks/alice/${t.id}`, { json: { assignee: 'alice' } })
    // Moving a team task assigned to Bob into a personal space is refused too.
    const team = await quick('Bob does this +bob')
    await api('POST', `/api/tasks/team/${team.id}/move`, {
      json: { toSpace: 'alice' },
      status: 400,
    })
  })

  it('lists people, projects and filters', async () => {
    expect(await api('GET', '/api/tasks/people')).toEqual([
      { email: ALICE, name: 'Alice', handle: 'alice' },
      { email: BOB, name: 'Bob', handle: 'bob' },
    ])
    await quick('One #Ops')
    const two = await quick('Two #Ops')
    await quick('Three #Ops', { space: 'team' })
    await quick(`Four ${addDays(today(), 30)}`)
    await api('POST', `/api/tasks/alice/${two.id}/complete`, { json: { tz: TZ } })
    expect(await api('GET', '/api/tasks/projects')).toEqual([
      { space: 'team', name: 'Ops', open: 1 },
      { space: 'alice', name: 'Ops', open: 1 },
    ])
    const ops = await api('GET', '/api/tasks?project=Ops&space=alice&status=all')
    expect(ops.tasks.map((t: TaskView) => t.title)).toEqual(['One', 'Two'])
    const soon = await api(`GET`, `/api/tasks?due_before=${addDays(today(), 7)}`)
    expect(soon.tasks).toEqual([])
    const later = await api(`GET`, `/api/tasks?due_before=${addDays(today(), 30)}`)
    expect(later.tasks.map((t: TaskView) => t.title)).toEqual(['Four'])
    const after = await api(`GET`, `/api/tasks?due_after=${addDays(today(), 30)}`)
    expect(after.tasks.map((t: TaskView) => t.title)).toEqual(['Four'])
    expect((await api(`GET`, `/api/tasks?due_after=${addDays(today(), 31)}`)).tasks).toEqual([])
    const inbox = await api('GET', '/api/tasks?project=&mine=true')
    expect(inbox.tasks.map((t: TaskView) => t.title)).toEqual(['Four'])
    const done = await api(
      'GET',
      `/api/tasks?status=done&done_since=${new Date(Date.now() - 60_000).toISOString()}`,
    )
    expect(done.tasks.map((t: TaskView) => t.title)).toEqual(['Two'])
    const search = await api('GET', '/api/tasks?q=three')
    expect(search.tasks.map((t: TaskView) => t.title)).toEqual(['Three'])
  })
})

describe('meeting action items', () => {
  it('a task from an action item ticks it when completed; converted items leave from-meetings', async () => {
    const path = 'meetings/2026/11/acme.md'
    const note = [
      '---',
      'type: meeting',
      'title: Acme sync',
      'date: 2026-11-10T10:00:00Z',
      '---',
      '# Acme sync',
      '',
      '- [ ] Send the deck',
      '- [ ] Book the room',
      '',
    ].join('\n')
    await api('PUT', '/api/spaces/alice/file', { json: { path, content: note } })
    const saved = await readRemote('alice', path)
    const line = saved.split('\n').indexOf('- [ ] Send the deck') + 1

    const before = await api('GET', '/api/tasks/from-meetings')
    expect(before).toEqual([
      expect.objectContaining({
        space: 'alice',
        path,
        items: [
          { line, text: 'Send the deck' },
          { line: line + 1, text: 'Book the room' },
        ],
      }),
    ])

    const task = await api<TaskView>('POST', '/api/tasks/quick', {
      json: {
        text: 'Send the deck today',
        tz: TZ,
        source: { kind: 'meeting', space: 'alice', path, line, text: 'Send the deck' },
      },
      status: 201,
    })
    const after = await api('GET', '/api/tasks/from-meetings')
    expect(after[0].items).toEqual([{ line: line + 1, text: 'Book the room' }])

    await api('POST', `/api/tasks/alice/${task.id}/complete`, { json: { tz: TZ } })
    expect((await readRemote('alice', path)).split('\n')[line - 1]).toBe('- [x] Send the deck')
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|meetings: complete "Send the deck"`)

    // Reopening it unticks the line, and completing it again ticks it again.
    await api('POST', `/api/tasks/alice/${task.id}/reopen`)
    expect((await readRemote('alice', path)).split('\n')[line - 1]).toBe('- [ ] Send the deck')
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|meetings: reopen "Send the deck"`)
    await api('POST', `/api/tasks/alice/${task.id}/complete`, { json: { tz: TZ } })
    expect((await readRemote('alice', path)).split('\n')[line - 1]).toBe('- [x] Send the deck')

    // A note that moved on doesn't stop a completion.
    const other = await api<TaskView>('POST', '/api/tasks/quick', {
      json: {
        text: 'Book it',
        tz: TZ,
        source: { kind: 'meeting', space: 'alice', path, line: line + 5, text: 'Book the room' },
      },
      status: 201,
    })
    const done = await api('POST', `/api/tasks/alice/${other.id}/complete`, { json: { tz: TZ } })
    expect(done.status).toBe('done')
    // …nor a reopen.
    const reopened = await api('POST', `/api/tasks/alice/${other.id}/reopen`)
    expect(reopened.status).toBe('open')
  })
})

describe('ramble', () => {
  it('transcribes, then proposes one task per sentence without saving any', async () => {
    const result = await api('POST', `/api/tasks/ramble?tz=${encodeURIComponent(TZ)}`, {
      body: new Uint8Array(4000),
      type: 'audio/webm;codecs=opus',
    })
    expect(result.transcript).toBe(asr.text)
    expect(
      result.tasks.map(
        (t: { title: string; due?: string; project?: string; priority?: number }) => ({
          title: t.title,
          project: t.project,
          priority: t.priority,
          hasDue: t.due !== undefined,
        }),
      ),
    ).toEqual([
      { title: 'Call Sam', project: undefined, priority: undefined, hasDue: true },
      { title: 'Send the deck', project: 'Board', priority: 1, hasDue: true },
      { title: 'book flights', project: undefined, priority: undefined, hasDue: false },
    ])
    expect(asr.calls[0]?.keyterms).toContain('Hotsauce')
    expect((await api('GET', '/api/tasks?status=all')).tasks).toEqual([])
  })

  it('falls back to the transcript as one task when the model fails, and checks the audio', async () => {
    respond = () => {
      throw new Error('down')
    }
    asr.text = 'Remember the milk'
    const result = await api('POST', '/api/tasks/ramble', {
      body: new Uint8Array(100),
      type: 'audio/mp4',
    })
    expect(result.tasks.map((t: { title: string }) => t.title)).toEqual(['Remember the milk'])
    await api('POST', '/api/tasks/ramble', {
      body: new Uint8Array(10),
      type: 'text/plain',
      status: 415,
    })
    // 13 MB is over the API's general limit but within a ramble's 15 MB.
    await api('POST', '/api/tasks/ramble', {
      body: new Uint8Array(13 * 1024 * 1024),
      type: 'audio/webm',
    })
    await api('POST', '/api/tasks/ramble', {
      body: new Uint8Array(16 * 1024 * 1024),
      type: 'audio/webm',
      status: 413,
    })
  })
})

describe('Todoist import', () => {
  it('imports from the API with a token, once', async () => {
    todoist.pages = {
      projects: [
        [
          { id: 'p0', name: 'Inbox', inbox_project: true },
          { id: 'p1', name: 'Board' },
        ],
      ],
      sections: [[{ id: 's1', name: 'Prep', project_id: 'p1' }]],
      tasks: [
        [
          {
            id: 't1',
            content: 'Send deck',
            priority: 4,
            project_id: 'p1',
            section_id: 's1',
            labels: ['work'],
          },
          { id: 't2', content: 'Slides', priority: 1, project_id: 'p1', parent_id: 't1' },
        ],
        [
          {
            id: 't3',
            content: 'Water plants',
            project_id: 'p0',
            due: { date: '2026-11-13', is_recurring: true, string: 'every friday' },
          },
        ],
      ],
    }
    await api('POST', '/api/tasks/import/todoist', { json: { token: 'bad' }, status: 400 })
    const first = await api('POST', '/api/tasks/import/todoist', { json: { token: 'good-token' } })
    expect(first).toEqual({ imported: 3, skipped: 0, projects: ['Board'] })
    expect(await lastCommit('alice')).toBe(`Alice <${ALICE}>|tasks: import 3 from Todoist`)
    expect(todoist.requests.filter((r) => r.url.includes('/tasks'))).toHaveLength(3)

    const tasks: TaskView[] = (await api('GET', '/api/tasks')).tasks
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]))
    expect(byTitle['Send deck']).toMatchObject({
      priority: 1,
      project: 'Board',
      labels: ['Prep', 'work'],
    })
    expect(byTitle.Slides).toMatchObject({ priority: 4, notes: 'Sub-task of: Send deck' })
    expect(byTitle['Water plants']).toMatchObject({
      project: null,
      recur: 'every friday',
      due: '2026-11-13',
    })
    expect(byTitle['Water plants']?.source).toEqual({ kind: 'import', from: 'todoist', ref: 't3' })

    todoist.pages.tasks?.[1]?.push({ id: 't4', content: 'New one' })
    const second = await api('POST', '/api/tasks/import/todoist', { json: { token: 'good-token' } })
    expect(second).toEqual({ imported: 1, skipped: 3, projects: [] })
    // The token is in no file, commit or response.
    expect(JSON.stringify(second)).not.toContain('good-token')
  })

  it('imports a CSV export, once, and refuses access tokens', async () => {
    const csv = [
      'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE',
      'task,Plan offsite @travel,Venue first,1,1,Alice,,every month,en,America/New_York',
      'section,Logistics,,,,,,,,',
      'task,Book hotel,,4,1,Alice,,tomorrow,en,America/New_York',
      'task,"Ask about ""late"" checkout",,2,2,Alice,,,en,America/New_York',
    ].join('\n')
    const body = { csv, projectName: 'Offsite', tz: TZ }
    expect(await api('POST', '/api/tasks/import/todoist', { json: body })).toEqual({
      imported: 3,
      skipped: 0,
      projects: ['Offsite'],
    })
    const tasks: TaskView[] = (await api('GET', '/api/tasks?project=Offsite')).tasks
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]))
    expect(byTitle['Plan offsite']).toMatchObject({
      priority: 1,
      labels: ['travel'],
      recur: 'every month',
    })
    expect(byTitle['Book hotel']).toMatchObject({ labels: ['Logistics'], due: addDays(today(), 1) })
    expect(byTitle['Ask about "late" checkout']).toMatchObject({
      priority: 2,
      notes: 'Sub-task of: Book hotel',
    })
    expect(await api('POST', '/api/tasks/import/todoist', { json: body })).toEqual({
      imported: 0,
      skipped: 3,
      projects: [],
    })

    const res = await call('POST', '/api/tokens', { as: ALICE, json: { name: 'agent' } })
    const { token } = (await res.json()) as { token: string }
    const withToken = await call('POST', '/api/tasks/import/todoist', { token, json: body })
    expect(withToken.status).toBe(403)
  })
})

describe('MCP tools', () => {
  async function connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { 'x-hearth-dev-user': ALICE } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    return client
  }

  async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    const first = result.content[0]
    const text = first?.type === 'text' ? first.text : ''
    return {
      isError: result.isError === true,
      text,
      value: result.isError ? null : JSON.parse(text),
    }
  }

  it('lists, adds, updates and completes tasks, and searches them', async () => {
    const client = await connect()
    const added = await tool(client, 'add_task', {
      text: 'Send deck fri p2 #Board',
      notes: 'The Q4 numbers',
      tz: TZ,
    })
    expect(added.value).toMatchObject({
      title: 'Send deck',
      priority: 2,
      project: 'Board',
      notes: 'The Q4 numbers',
      source: { kind: 'mcp' },
    })
    const log = await runGit(bare('alice'), ['log', '-1', '--format=%an <%ae>|%B', 'main'])
    expect(log).toContain(`Alice <${ALICE}>|tasks: create "Send deck"`)
    expect(log).toContain('Hearth-Via: mcp')

    const listed = await tool(client, 'list_tasks')
    expect(listed.value.map((t: TaskView) => t.title)).toEqual(['Send deck'])

    const updated = await tool(client, 'update_task', {
      space: 'alice',
      id: added.value.id,
      priority: 1,
      project: null,
    })
    expect(updated.value).toMatchObject({ priority: 1, project: null })

    const done = await tool(client, 'complete_task', { space: 'alice', id: added.value.id })
    expect(done.value.status).toBe('done')
    expect((await tool(client, 'list_tasks')).value).toEqual([])
    expect((await tool(client, 'list_tasks', { status: 'done' })).value).toHaveLength(1)

    const found = await tool(client, 'search', { query: 'Q4 numbers', kind: 'task' })
    expect(found.value).toEqual([
      expect.objectContaining({ space: 'alice', path: added.value.path, title: 'Send deck' }),
    ])
    expect((await tool(client, 'search', { query: 'Q4 numbers', kind: 'docs' })).value).toEqual([])

    const bobTask = await quick('Bob private', { as: BOB })
    const refused = await tool(client, 'complete_task', { space: 'bob', id: bobTask.id })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^forbidden:/)
    await client.close()
  })
})

describe('index', () => {
  it('a full reindex picks tasks up as kind task', async () => {
    const t = await quick('Reindex me')
    services.index.reindexSpace('alice', [])
    expect(services.index.getFile('alice', t.path)).toBeNull()
    await services.indexer.full('alice')
    expect(services.index.getFile('alice', t.path)).toMatchObject({
      kind: 'task',
      title: 'Reindex me',
    })
    expect((await api('GET', '/api/tasks')).tasks.map((x: TaskView) => x.title)).toEqual([
      'Reindex me',
    ])
  })
})
