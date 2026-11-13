import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { ANSWERS_PER_IP_PER_HOUR } from '../../src/forms/index.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM } from '../../src/meetings/index.js'
import { DEV_TURNSTILE_TOKEN } from '../../src/scheduling/turnstile.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Hearth Forms (docs/plans/2026-11-12-forms.md R1, R5–R13; ARCHITECTURE §21) through the API
// with dev auth, the dev robot check, the fake LLM and a fake chat webhook.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const ADMIN = 'admin@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let posts: Array<{ url: string; body: { text: string } }>
let llm: FakeLLM

beforeEach(async () => {
  root = await makeTempDir('hearth-forms-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ADMIN_EMAILS: ADMIN,
    PUBLIC_URL: 'https://hearth.example.test',
  })
  posts = []
  llm = new FakeLLM(() => '- Most people want earlier lab hours (2 answers).')
  services = createServices(config, {
    llm,
    chatFetch: async (input, init) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response('ok')
    },
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(
  method: string,
  path: string,
  opts: { as?: string | null; json?: unknown; body?: BodyInit; ip?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (opts.as !== null) headers['x-hearth-dev-user'] = opts.as ?? ALICE
  if (opts.ip) headers['fly-client-ip'] = opts.ip
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string | null; json?: unknown; body?: BodyInit; ip?: string; status?: number } = {},
): Promise<T> {
  const res = await call(method, path, opts)
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T
}

const QUESTIONS = [
  { id: 'name', type: 'short', label: 'Your name', required: true },
  {
    id: 'role',
    type: 'choice',
    label: 'Where do you work?',
    options: ['Lab', 'Office'],
    required: true,
  },
  {
    id: 'kit',
    type: 'multi',
    label: 'What do you need?',
    options: ['Gloves', 'Goggles'],
    show_if: { question: 'role', is: 'Lab' },
  },
  { id: 'stars', type: 'rating', label: 'How was it?', scale: 5 },
  { id: 'cv', type: 'file', label: 'Anything to attach' },
]

/** A form in `space` with the questions above, saved with `over`. */
async function makeForm(over: Record<string, unknown> = {}, space = 'team', as = ALICE) {
  const created = await api('POST', '/api/forms', { as, json: { space, title: 'Lab kit request' } })
  const saved = await api('PUT', `/api/forms/${space}/${created.id}`, {
    as,
    json: {
      title: 'Lab kit request',
      description: 'Ask for safety kit.',
      questions: QUESTIONS,
      access: 'team',
      open: true,
      room: null,
      blobOid: created.blobOid,
      ...over,
    },
  })
  return { ...saved, link: new URL(saved.url).pathname.split('/').pop() as string }
}

const lastCommit = (space: string) =>
  runGit(join(root, 'data', 'repos', space), ['log', '-1', '--format=%an <%ae>%n%B'])

function multipart(payload: unknown, files: Array<[string, File]> = []) {
  const fd = new FormData()
  fd.set('payload', JSON.stringify(payload))
  for (const [q, f] of files) fd.append(`file:${q}`, f)
  return fd
}

describe('building forms (R1, R5)', () => {
  it('creates, saves and lists a form as a file in the space', async () => {
    const form = await makeForm()
    expect(form).toMatchObject({
      space: 'team',
      title: 'Lab kit request',
      access: 'team',
      open: true,
    })
    expect(form.url).toMatch(/^https:\/\/hearth\.example\.test\/f\/[A-Za-z0-9_-]{24}$/)
    expect(form.questions).toHaveLength(5)
    expect(await lastCommit('team')).toContain(`Alice <${ALICE}>`)
    expect(await lastCommit('team')).toContain('forms: edit "Lab kit request"')

    const { forms } = await api('GET', '/api/forms', { as: BOB })
    expect(forms).toEqual([expect.objectContaining({ id: form.id, answerCount: 0 })])
    const file = await services.git.readFile('team', `forms/${form.id}.md`)
    expect(file.content).toContain('type: form')
    expect(file.content).toContain('- Where do you work?')
  })

  it('refuses a stale save, bad questions and writes from outside Forms', async () => {
    const form = await makeForm()
    const input = {
      title: 'X',
      description: '',
      questions: QUESTIONS,
      access: 'team',
      open: true,
      room: null,
    }
    await api('PUT', `/api/forms/team/${form.id}`, {
      json: { ...input, blobOid: 'a'.repeat(40) },
      status: 409,
    })
    const bad = await api('PUT', `/api/forms/team/${form.id}`, {
      json: {
        ...input,
        questions: [{ id: 'a', type: 'choice', label: 'A', options: [] }],
        blobOid: form.blobOid,
      },
      status: 400,
    })
    expect(bad.error.message).toMatch(/at least one option/)
    // A Docs save can't forge a form or an answer.
    const res = await call('PUT', '/api/spaces/team/file', {
      json: { path: `forms/${form.id}/01JD0000000000000000000000.md`, content: 'x' },
    })
    expect(res.status).toBe(403)
  })

  it('keeps a personal form and its answers to its owner (R9)', async () => {
    const me = await api('GET', '/api/me')
    const personal = me.spaces.find((s: { kind: string }) => s.kind === 'personal').name
    const form = await makeForm({}, personal)
    await api('GET', `/api/forms/${personal}/${form.id}`, { as: BOB, status: 403 })
    expect((await api('GET', '/api/forms', { as: BOB })).forms).toEqual([])
    // Any member can still answer a team-only form wherever it lives (R7).
    await api('POST', `/api/form/${form.link}`, {
      as: BOB,
      json: { answers: { name: 'Bob', role: 'Office' } },
    })
    expect(await api('GET', `/api/forms/${personal}/${form.id}/answers`)).toMatchObject({
      answers: [expect.objectContaining({ submittedBy: BOB })],
    })
    await api('GET', `/api/forms/${personal}/${form.id}/answers`, { as: BOB, status: 403 })
    const hits = await api('GET', `/api/search?q=Bob`, { as: BOB })
    expect(JSON.stringify(hits)).not.toContain(form.id)
  })

  it('deletes a form and its answers to the trash in one commit', async () => {
    const form = await makeForm()
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'Ada', role: 'Office' } },
    })
    await api('DELETE', `/api/forms/team/${form.id}`, { status: 204 })
    expect((await api('GET', '/api/forms')).forms).toEqual([])
    await api('GET', `/api/form/${form.link}`, { status: 404 })
    expect(await lastCommit('team')).toContain('forms: delete "Lab kit request"')
  })
})

describe('answering (R6–R10)', () => {
  it('takes a team answer from a member, drops hidden answers and records who', async () => {
    const form = await makeForm()
    const page = await api('GET', `/api/form/${form.link}`, { as: BOB })
    expect(page).toMatchObject({
      title: 'Lab kit request',
      access: 'team',
      canTakeAnswers: true,
      robotCheck: null,
    })
    expect(JSON.stringify(page)).not.toContain('team/')
    await api('GET', `/api/form/${form.link}`, { as: null, status: 401 })
    await api('POST', `/api/form/${form.link}`, {
      as: null,
      json: { answers: { name: 'X', role: 'Lab' } },
      status: 401,
    })

    const { id } = await api('POST', `/api/form/${form.link}`, {
      as: BOB,
      json: { answers: { name: ' Bob ', role: 'Office', kit: ['Gloves'], stars: 4 } },
    })
    const { answers } = await api('GET', `/api/forms/team/${form.id}/answers`)
    expect(answers).toEqual([
      {
        id,
        submitted: expect.any(String),
        submittedBy: BOB,
        answers: { name: 'Bob', role: 'Office', stars: 4 },
      },
    ])
    expect(await lastCommit('team')).toContain(`Bob <${BOB}>`)
    expect(await lastCommit('team')).toContain('forms: answer "Lab kit request"')
    const hits = await api('GET', `/api/search?q=Bob`)
    expect(JSON.stringify(hits)).toContain(id)
  })

  it('refuses answers that do not fit, with the reasons per question (R4)', async () => {
    const form = await makeForm()
    const bad = await api('POST', `/api/form/${form.link}`, {
      json: { answers: { role: 'Remote', stars: 9 } },
      status: 400,
    })
    expect(bad.error.details.errors).toEqual({
      name: expect.any(String),
      role: expect.any(String),
      stars: expect.any(String),
    })
  })

  it('stops answers once the form is closed (R6)', async () => {
    const form = await makeForm({ open: false })
    expect((await api('GET', `/api/form/${form.link}`)).canTakeAnswers).toBe(false)
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'A', role: 'Lab' } },
      status: 409,
    })
    await api('GET', `/api/form/${'x'.repeat(24)}`, { status: 404 })
  })

  it('takes a signed-out answer on a public form behind the robot check and limits (R8)', async () => {
    const form = await makeForm({ access: 'public' })
    const page = await api('GET', `/api/form/${form.link}`, { as: null })
    expect(page).toMatchObject({ canTakeAnswers: true, robotCheck: { kind: 'dev' } })
    const answer = { answers: { name: 'Outsider', role: 'Office' } }
    await api('POST', `/api/form/${form.link}`, {
      as: null,
      json: { ...answer, token: 'nope' },
      status: 403,
    })
    const { id } = await api('POST', `/api/form/${form.link}`, {
      as: null,
      ip: '203.0.113.9',
      json: { ...answer, token: DEV_TURNSTILE_TOKEN },
    })
    const { answers } = await api('GET', `/api/forms/team/${form.id}/answers`)
    expect(answers[0]).toMatchObject({ id, submittedBy: null })
    const commit = await lastCommit('team')
    expect(commit).toContain('Forms <forms@hearth.example.test>')
    expect(commit).toContain('Hearth-Via: forms (public link)')

    for (let i = 1; i < ANSWERS_PER_IP_PER_HOUR; i++) {
      await api('POST', `/api/form/${form.link}`, {
        as: null,
        ip: '203.0.113.9',
        json: { ...answer, token: DEV_TURNSTILE_TOKEN },
      })
    }
    await api('POST', `/api/form/${form.link}`, {
      as: null,
      ip: '203.0.113.9',
      json: { ...answer, token: DEV_TURNSTILE_TOKEN },
      status: 429,
    })
  })

  it('says a public form cannot take signed-out answers without Turnstile', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data2'),
      LOCAL_HOST_DIR: join(root, 'remotes2'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    })
    const other = createServices(config, { robotCheck: null })
    await other.spaces.ensureTeamSpace()
    const otherApp = createApp(other)
    try {
      const h = { 'x-hearth-dev-user': ALICE, 'content-type': 'application/json' }
      const created = await (
        await otherApp.request('/api/forms', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ space: 'team', title: 'Survey' }),
        })
      ).json()
      const saved = await (
        await otherApp.request(`/api/forms/team/${created.id}`, {
          method: 'PUT',
          headers: h,
          body: JSON.stringify({
            title: 'Survey',
            description: '',
            questions: created.questions,
            access: 'public',
            open: true,
            room: null,
            blobOid: created.blobOid,
          }),
        })
      ).json()
      const link = new URL(saved.url).pathname.split('/').pop()
      const page = await (await otherApp.request(`/api/form/${link}`)).json()
      expect(page).toMatchObject({ canTakeAnswers: false, robotCheck: null })
      const res = await otherApp.request(`/api/form/${link}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: { q1: 'A' }, token: DEV_TURNSTILE_TOKEN }),
      })
      expect(res.status).toBe(503)
      // A member signed in still can.
      const mine = await otherApp.request(`/api/form/${link}`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ answers: { q1: 'A' } }),
      })
      expect(mine.status).toBe(200)
    } finally {
      await other.meetings.sessions.close()
      other.meetings.calendarSync?.cache.close()
      other.index.close()
      other.dictation.store.close()
    }
  })

  it('stores uploaded files in Hearth Files and ignores file references in the JSON (R10)', async () => {
    const form = await makeForm({ access: 'public' })
    const forged = { cv: [{ id: '01JD0000000000000000000000', name: 'secret.pdf', size: 1 }] }
    const { id } = await api('POST', `/api/form/${form.link}`, {
      as: null,
      body: multipart(
        { answers: { name: 'Ada', role: 'Office', ...forged }, token: DEV_TURNSTILE_TOKEN },
        [['cv', new File(['hello from a cv'], 'cv.txt', { type: 'text/plain' })]],
      ),
    })
    const { answers } = await api('GET', `/api/forms/team/${form.id}/answers`)
    const row = answers.find((a: { id: string }) => a.id === id)
    expect(row.answers.cv).toEqual([{ id: expect.any(String), name: 'cv.txt', size: 15 }])
    expect(row.answers.cv[0].id).not.toBe(forged.cv[0]?.id)
    const file = await api('GET', `/api/files/item/team/${row.answers.cv[0].id}?text=1`)
    expect(file).toMatchObject({ name: 'cv.txt', folder: 'Forms/Lab kit request' })

    const four = Array.from({ length: 4 }, (_, i): [string, File] => [
      'cv',
      new File(['x'], `${i}.txt`),
    ])
    await api('POST', `/api/form/${form.link}`, {
      as: null,
      body: multipart(
        { answers: { name: 'Ada', role: 'Office' }, token: DEV_TURNSTILE_TOKEN },
        four,
      ),
      status: 400,
    })
  })
})

describe('refusing early (review fixes)', () => {
  it('refuses a bad link or a closed form before reading the body, and caps text-only answers', async () => {
    const big = multipart({ answers: {} }, [
      ['cv', new File([new Uint8Array(2 * 1024 * 1024)], 'big.bin')],
    ])
    await api('POST', `/api/form/${'A'.repeat(24)}`, { as: null, body: big, status: 404 })
    const closed = await makeForm({ open: false })
    await api('POST', `/api/form/${closed.link}`, { body: big, status: 409 })
    // A form with no file question takes no big body.
    const plain = await makeForm({ questions: QUESTIONS.slice(0, 2) })
    await api('POST', `/api/form/${plain.link}`, { body: big, status: 413 })
  })

  it('counts signed-out answers without a client address together', async () => {
    const form = await makeForm({ access: 'public' })
    const answer = { answers: { name: 'X', role: 'Office' }, token: DEV_TURNSTILE_TOKEN }
    for (let i = 0; i < ANSWERS_PER_IP_PER_HOUR; i++) {
      await api('POST', `/api/form/${form.link}`, { as: null, json: answer })
    }
    await api('POST', `/api/form/${form.link}`, { as: null, json: answer, status: 429 })
  })

  it("prefers the team's form when a copy in a personal space shares its link", async () => {
    const form = await makeForm()
    const me = await api('GET', '/api/me', { as: BOB })
    const personal = me.spaces.find((s: { kind: string }) => s.kind === 'personal').name
    const file = await services.git.readFile('team', `forms/${form.id}.md`)
    const copyId = '01JD0000000000000000000009'
    await services.git.commit(personal, {
      changes: [{ path: `forms/${copyId}.md`, content: file.content.replace(form.id, copyId) }],
      author: { name: 'Bob', email: BOB },
      message: 'copy',
    })
    await services.syncer.afterHeadChanged(personal)
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'A', role: 'Office' } },
    })
    expect((await api('GET', `/api/forms/team/${form.id}/answers`)).answers).toHaveLength(1)
  })
})

describe('reading answers (R11, R12)', () => {
  it('exports CSV and deletes an answer', async () => {
    const form = await makeForm()
    const a = await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: '=cmd', role: 'Lab', kit: ['Goggles'] } },
    })
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'Bea', role: 'Office' } },
    })
    const res = await call('GET', `/api/forms/team/${form.id}/csv`)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Lab kit request.csv"',
    )
    const csv = await res.text()
    expect(csv).toContain(
      'Submitted,From,Your name,Where do you work?,What do you need?,How was it?,Anything to attach',
    )
    expect(csv).toContain(`'=cmd,Lab,Goggles`)
    await api('DELETE', `/api/forms/team/${form.id}/answers/${a.id}`, { status: 204 })
    expect((await api('GET', `/api/forms/team/${form.id}/answers`)).answers).toHaveLength(1)
    expect((await api('GET', '/api/forms')).forms[0].answerCount).toBe(1)
  })

  it('counts choices and ratings and asks Claude for themes', async () => {
    const form = await makeForm()
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'A', role: 'Lab', kit: ['Gloves', 'Goggles'], stars: 5 } },
    })
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'B', role: 'Lab', kit: ['Goggles'], stars: 2 } },
    })
    const out = await api('POST', `/api/forms/team/${form.id}/summary`)
    expect(out.summary).toContain('earlier lab hours')
    expect(out).toMatchObject({ read: 2, total: 2 })
    expect(out.tallies).toEqual([
      {
        question: 'role',
        counts: [
          { option: 'Lab', count: 2 },
          { option: 'Office', count: 0 },
        ],
        answered: 2,
      },
      {
        question: 'kit',
        counts: [
          { option: 'Gloves', count: 1 },
          { option: 'Goggles', count: 2 },
        ],
        answered: 2,
      },
      { question: 'stars', average: 3.5, answered: 2 },
    ])
    expect(llm.calls.at(-1)?.messages[0]?.content).toContain('Form: Lab kit request')
  })
})

describe('chat rooms (R13)', () => {
  it('lets only an admin add rooms, hides the webhook, and posts new answers', async () => {
    await api('POST', '/api/chat-rooms', {
      json: { name: 'Ops', url: 'https://chat.example.test/hook/abcd1234' },
      status: 403,
    })
    await api('POST', '/api/chat-rooms', {
      as: ADMIN,
      json: { name: 'Ops', url: 'http://insecure.test/x' },
      status: 400,
    })
    const room = await api('POST', '/api/chat-rooms', {
      as: ADMIN,
      json: { name: 'Ops', url: 'https://chat.example.test/hook/abcd1234' },
    })
    expect(room).toEqual({ id: expect.any(String), name: 'Ops', last4: '1234' })
    expect(await api('GET', '/api/chat-rooms')).toEqual({
      rooms: [{ id: room.id, name: 'Ops' }],
      canManage: false,
    })
    expect(JSON.stringify(await api('GET', '/api/chat-rooms', { as: ADMIN }))).not.toContain(
      'chat.example.test',
    )

    const form = await makeForm({ room: room.id })
    const { id } = await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'Ada <@here>', role: 'Office' } },
    })
    expect(posts).toHaveLength(2)
    expect(posts[0]?.body.text).toContain('Hearth Forms is connected')
    expect(posts[1]?.url).toBe('https://chat.example.test/hook/abcd1234')
    expect(posts[1]?.body.text).toContain('New answer to *Lab kit request*')
    expect(posts[1]?.body.text).toContain('> Your name: Ada &lt;@here&gt;')
    expect(posts[1]?.body.text).toContain(
      `<https://hearth.example.test/forms/team/${form.id}/answers?answer=${id}|Open the answer>`,
    )
    // Nothing about the webhook went into Git.
    const file = await services.git.readFile('team', `forms/${form.id}.md`)
    expect(file.content).not.toContain('chat.example.test')

    await api('DELETE', `/api/chat-rooms/${room.id}`, { as: ADMIN, status: 204 })
    // The answer still saves; nothing is posted.
    await api('POST', `/api/form/${form.link}`, {
      json: { answers: { name: 'B', role: 'Office' } },
    })
    expect(posts).toHaveLength(2)
  })

  it('refuses a link that is not a Slack-compatible webhook, with the reason', async () => {
    const msg = await api('POST', '/api/chat-rooms', {
      as: ADMIN,
      json: { name: 'Ops', url: 'https://chat.example.test/rooms/abc/key123/messages' },
      status: 400,
    })
    expect(msg.error.message).toMatch(/Slack-compatible/)
    expect(posts).toHaveLength(0)
    for (const url of [
      'https://localhost/x/slack',
      'https://169.254.169.254/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
    ]) {
      await api('POST', '/api/chat-rooms', { as: ADMIN, json: { name: 'X', url }, status: 400 })
    }
    expect(posts).toHaveLength(0)
    const failing = createServices(
      loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'dev',
        HOST_KIND: 'local',
        DATA_DIR: join(root, 'data3'),
        LOCAL_HOST_DIR: join(root, 'remotes3'),
        ALLOWED_EMAIL_DOMAINS: 'example.test',
      }),
      { chatFetch: async () => new Response('invalid_payload', { status: 400 }) },
    )
    try {
      await expect(
        failing.chatRooms.add('Ops', 'https://chat.example.test/x/slack'),
      ).rejects.toThrow(/didn’t take a test message \(it answered 400\)/)
      expect(failing.chatRooms.list()).toEqual([])
    } finally {
      await failing.meetings.sessions.close()
      failing.meetings.calendarSync?.cache.close()
      failing.index.close()
      failing.dictation.store.close()
    }
  })

  it('keeps the answer when the chat post fails', async () => {
    const room = await api('POST', '/api/chat-rooms', {
      as: ADMIN,
      json: { name: 'Ops', url: 'https://chat.example.test/h' },
    })
    const form = await makeForm({ room: room.id })
    const original = services.chatRooms.post.bind(services.chatRooms)
    services.chatRooms.post = async () => false
    try {
      await api('POST', `/api/form/${form.link}`, {
        json: { answers: { name: 'A', role: 'Office' } },
      })
    } finally {
      services.chatRooms.post = original
    }
    expect((await api('GET', `/api/forms/team/${form.id}/answers`)).answers).toHaveLength(1)
  })
})
