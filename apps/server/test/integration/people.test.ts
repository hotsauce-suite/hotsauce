import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { Principal } from '../../src/auth/index.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import type { CalendarEvent, CalendarSource } from '../../src/meetings/calendar/types.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import type { CompanyView, PersonSummary, PersonView } from '../../src/people/index.js'
import { createServices, type Services } from '../../src/services.js'
import { catFile, makeTempDir, removeDir } from '../helpers/git.js'

// People (ARCHITECTURE §17, plan P1–P5): a light CRM derived from meeting attendees, calendar
// events and task assignees, only from what each member can read.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const DANA = 'dana@acme.com'
const LEE = 'lee@acme.com'
const PAT = 'pat@gmail.com'
const SECRET = 'secret@hidden.org'

class TestCalendar implements CalendarSource {
  events: CalendarEvent[] = []
  async upcoming(_p: Principal, range: { from: string; to: string }): Promise<CalendarEvent[]> {
    return this.events.filter((e) => e.end > range.from && e.start < range.to)
  }
}

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let calendar: TestCalendar

beforeEach(async () => {
  root = await makeTempDir('hearth-people-')
  calendar = new TestCalendar()
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
    }),
    { calendar, llm: new FakeLLM(scriptedResponse) },
  )
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', ALICE)
  await call('GET', '/api/me', BOB)
})

afterEach(async () => {
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, url: string, as = ALICE, json?: unknown): Promise<Response> {
  return app.request(url, {
    method,
    headers: {
      'x-hearth-dev-user': as,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  url: string,
  as = ALICE,
  json?: unknown,
  status = 200,
): Promise<T> {
  const res = await call(method, url, as, json)
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

const meetingNote = (title: string, date: string, attendees: string[]) =>
  [
    '---',
    'type: meeting',
    `title: ${title}`,
    `date: ${date}`,
    'attendees:',
    ...attendees.map((a) => `  - ${a}`),
    '---',
    `# ${title}`,
    '',
    'Notes.',
    '',
  ].join('\n')

const write = (space: string, path: string, content: string, as = ALICE) =>
  api('PUT', `/api/spaces/${space}/file`, as, { path, content })

const people = async (as = ALICE, query = '') =>
  (await api<{ people: PersonSummary[] }>('GET', `/api/people${query}`, as)).people
const person = (email: string, as = ALICE) =>
  api<PersonView>('GET', `/api/people/${encodeURIComponent(email)}`, as)

const bare = (space: string) => join(root, 'remotes', `${space}.git`)
const lastCommit = async (space: string) =>
  (await runGit(bare(space), ['log', '-1', '--format=%an <%ae>|%s', 'main'])).trim()

/** Alice's world: two Acme meetings (one personal), a team one with Pat, and Bob's secret one. */
async function seed() {
  const now = Date.now()
  await write(
    'alice',
    'meetings/2026/11/acme-1.md',
    meetingNote('Acme kickoff', iso(now - 9 * DAY), [ALICE, `Dana Lee <${DANA}>`]),
  )
  await write(
    'team',
    'meetings/2026/11/acme-2.md',
    meetingNote('Acme sync', iso(now - 2 * DAY), [ALICE, DANA, LEE, BOB]),
  )
  await write(
    'team',
    'meetings/2026/11/pat.md',
    meetingNote('Coffee with Pat', iso(now - 5 * DAY), [ALICE, `Pat Q <${PAT}>`]),
  )
  await write(
    'bob',
    'meetings/2026/11/secret.md',
    meetingNote('Bob private', iso(now - 1 * DAY), [BOB, SECRET, DANA]),
    BOB,
  )
  calendar.events = [
    {
      id: 'ev-next',
      title: 'Acme renewal',
      start: iso(now + 3 * DAY),
      end: iso(now + 3 * DAY + 1_800_000),
      attendees: [{ email: ALICE }, { email: DANA, name: 'Dana Lee' }],
    },
    {
      id: 'ev-later',
      title: 'Acme QBR',
      start: iso(now + 10 * DAY),
      end: iso(now + 10 * DAY + 1_800_000),
      attendees: [{ email: ALICE }, { email: DANA }, { email: 'new@fresh.io', name: 'Nia New' }],
    },
  ]
}

describe('People', () => {
  it('P1: every attendee of a readable meeting is a person with count, last and next meeting', async () => {
    await seed()
    const list = await people()
    const byEmail = new Map(list.map((p) => [p.email, p]))
    expect([...byEmail.keys()].sort()).toEqual([BOB, DANA, LEE, 'new@fresh.io', PAT].sort())
    expect(byEmail.has(ALICE)).toBe(false)
    expect(byEmail.get(DANA)).toMatchObject({
      name: 'Dana Lee',
      company: 'acme.com',
      team: false,
      meetings: 2,
      last: { space: 'team', path: 'meetings/2026/11/acme-2.md', title: 'Acme sync' },
      next: { title: 'Acme renewal' },
    })
    expect(byEmail.get(LEE)).toMatchObject({ meetings: 1, next: null, name: null })
    // Seen only on the calendar: a person with no meetings yet, and their next one.
    expect(byEmail.get('new@fresh.io')).toMatchObject({
      name: 'Nia New',
      meetings: 0,
      last: null,
      next: { title: 'Acme QBR' },
    })
    // Most recent meeting first (then most meetings, then email); people with none come last.
    expect(list.map((p) => p.email)).toEqual([DANA, BOB, LEE, PAT, 'new@fresh.io'])

    const view = await person(DANA)
    expect(view.history.map((m) => m.title)).toEqual(['Acme sync', 'Acme kickoff'])
    expect(view.about).toEqual({ text: '', blobOid: null })
    // Search by name, email or company.
    expect((await people(ALICE, '?q=dana')).map((p) => p.email)).toEqual([DANA])
    expect((await people(ALICE, '?q=acme')).map((p) => p.email)).toEqual([DANA, LEE])
  })

  it('P2: someone seen only in a teammate’s personal meeting doesn’t exist for you', async () => {
    await seed()
    expect((await people()).map((p) => p.email)).not.toContain(SECRET)
    await api('GET', `/api/people/${SECRET}`, ALICE, undefined, 404)
    // Dana is shared, but Bob's private meeting doesn't count toward Alice's view of her.
    const dana = await person(DANA)
    expect(dana.history.map((m) => m.title)).not.toContain('Bob private')
    expect(JSON.stringify(dana)).not.toMatch(/Bob private/)
    // Bob sees his own: the secret person and the private meeting.
    const bobs = await people(BOB)
    expect(bobs.map((p) => p.email)).toContain(SECRET)
    expect((await person(DANA, BOB)).history.map((m) => m.title)).toEqual([
      'Bob private',
      'Acme sync',
    ])
    await api('PUT', `/api/people/${SECRET}/about`, ALICE, { text: 'x', blobOid: null }, 404)
  })

  it('P2: no team About for someone only you can see', async () => {
    await seed()
    // Only in Bob's personal meeting: a team file would tell Alice they exist.
    await api('PUT', `/api/people/${SECRET}/about`, BOB, { text: 'x', blobOid: null }, 403)
    expect((await person(SECRET, BOB)).canEditAbout).toBe(false)
    // Only on Alice's calendar: same.
    await api('PUT', '/api/people/new@fresh.io/about', ALICE, { text: 'x', blobOid: null }, 403)
    const files = await api('GET', '/api/spaces/team/tree?dir=', ALICE).catch(() => null)
    expect(JSON.stringify(files ?? '')).not.toContain('hidden.org')
    await call('GET', `/api/spaces/team/file?path=people/${SECRET}.md`).then((r) =>
      expect(r.status).toBe(404),
    )
    // Seen in a team meeting, or a member: the team can already see them.
    expect((await person(DANA)).canEditAbout).toBe(true)
    expect((await person(BOB)).canEditAbout).toBe(true)
  })

  it('two first saves of an About at once: one lands, the other is a conflict', async () => {
    await seed()
    const url = `/api/people/${DANA}/about`
    const [a, b] = await Promise.all([
      call('PUT', url, ALICE, { text: 'From Alice', blobOid: null }),
      call('PUT', url, BOB, { text: 'From Bob', blobOid: null }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const winner = a.status === 200 ? 'From Alice' : 'From Bob'
    expect((await person(DANA)).about.text).toBe(winner)
  })

  it('an email with a percent sign works in the URL', async () => {
    const now = Date.now()
    await write(
      'team',
      'meetings/2026/11/odd.md',
      meetingNote('Odd', iso(now - DAY), [ALICE, 'a%b@acme.com']),
    )
    expect((await person('a%b@acme.com')).email).toBe('a%b@acme.com')
  })

  it('P3: companies group by domain; ours are Team; personal mail forms no company', async () => {
    await seed()
    const list = await people()
    const bob = list.find((p) => p.email === BOB)
    expect(bob).toMatchObject({ team: true, company: 'example.test' })
    const pat = list.find((p) => p.email === PAT)
    expect(pat).toMatchObject({ team: false, company: null, name: 'Pat Q' })
    const acme = await api<CompanyView>('GET', '/api/companies/acme.com')
    expect(acme.domain).toBe('acme.com')
    expect(acme.team).toBe(false)
    expect(acme.people.map((p) => p.email)).toEqual([DANA, LEE])
    expect(acme.meetings.map((m) => m.title)).toEqual(['Acme sync', 'Acme kickoff'])
    await api('GET', '/api/companies/gmail.com', ALICE, undefined, 404)
    await api('GET', '/api/companies/hidden.org', ALICE, undefined, 404)
  })

  it('P4: About is a team file written by the member and survives a reindex', async () => {
    await seed()
    const saved = await api<{ blobOid: string }>(
      'PUT',
      `/api/people/${encodeURIComponent(DANA)}/about`,
      ALICE,
      { text: 'Head of security at Acme.\nPrefers email.', blobOid: null },
    )
    expect(await lastCommit('team')).toBe(`Alice <${ALICE}>|people: edit "Dana Lee"`)
    const file = await catFile(bare('team'), 'main', `people/${DANA}.md`)
    expect(file).toContain(`email: ${DANA}`)
    expect(file).toContain('Head of security at Acme.\nPrefers email.')
    expect((await person(DANA)).about).toEqual({
      text: 'Head of security at Acme.\nPrefers email.',
      blobOid: saved.blobOid,
    })
    // Bob sees the same About.
    expect((await person(DANA, BOB)).about.text).toBe('Head of security at Acme.\nPrefers email.')

    // A stale save is refused; creating over an existing file too.
    await api(
      'PUT',
      `/api/people/${DANA}/about`,
      BOB,
      { text: 'Old', blobOid: '0'.repeat(40) },
      409,
    )
    await api('PUT', `/api/people/${DANA}/about`, BOB, { text: 'New', blobOid: null }, 409)
    const again = await api('PUT', `/api/people/${DANA}/about`, BOB, {
      text: 'Head of security. Prefers email.',
      blobOid: saved.blobOid,
    })
    expect(again.blobOid).not.toBe(saved.blobOid)

    const before = await people()
    services.index.reindexSpace('team', [])
    services.index.reindexSpace('alice', [])
    await services.indexer.full('team')
    await services.indexer.full('alice')
    expect(await people()).toEqual(before)
    expect((await person(DANA)).about.text).toBe('Head of security. Prefers email.')
  })

  it('P5: the person page lists open tasks assigned to them', async () => {
    await seed()
    await api('POST', '/api/tasks', ALICE, { title: 'Review Acme contract', assignee: BOB }, 201)
    const done = await api('POST', '/api/tasks', ALICE, { title: 'Old thing', assignee: BOB }, 201)
    await api('POST', '/api/tasks', ALICE, { title: 'Mine' }, 201)
    await api('POST', `/api/tasks/${done.space}/${done.id}/complete`, ALICE, { tz: 'UTC' })
    const bob = await person(BOB)
    expect(bob.tasks.map((t) => t.title)).toEqual(['Review Acme contract'])
  })

  it('refuses a bad email and a bad body', async () => {
    await api('GET', '/api/people/not-an-email', ALICE, undefined, 400)
    await seed()
    await api('PUT', `/api/people/${DANA}/about`, ALICE, { text: 5, blobOid: null }, 400)
    await api(
      'PUT',
      `/api/people/${DANA}/about`,
      ALICE,
      { text: 'x'.repeat(20_001), blobOid: null },
      400,
    )
  })

  it('MCP: find_person and get_person, only from what the member can read', async () => {
    await seed()
    const res = await call('POST', '/api/tokens', ALICE, { name: 'Claude' })
    const { token } = (await res.json()) as { token: string }
    const transport = new StreamableHTTPClientTransport(new URL('http://hearth.test/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.request(new Request(input, init)),
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(transport)
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult
      const first = r.content[0]
      return { error: r.isError === true, text: first?.type === 'text' ? first.text : '' }
    }
    const found = await callTool('find_person', { q: 'acme' })
    expect(JSON.parse(found.text).map((p: PersonSummary) => p.email)).toEqual([DANA, LEE])
    const got = await callTool('get_person', { email: DANA })
    expect(JSON.parse(got.text)).toMatchObject({ email: DANA, meetings: 2 })
    const hidden = await callTool('get_person', { email: SECRET })
    expect(hidden.error).toBe(true)
    expect((await callTool('find_person', { q: 'secret' })).text).toBe('[]')
    await client.close()
  })
})
