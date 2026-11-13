import { existsSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { type Config, loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import {
  audioFrame,
  FakeCalendar,
  FakeLLM,
  FakeRetranscriber,
  FakeTranscriber,
  type LLMRequest,
  type MeetingRetranscriber,
  type MeetingSession,
  MeetingSocketServer,
  scriptedResponse,
  type Track,
  type TranscriptSegment,
  WS_FORBIDDEN,
  WS_NOT_FOUND,
  WS_REPLACED,
} from '../../src/meetings/index.js'
import { FakePushSender } from '../../src/meetings/reminders/index.js'
import { createServices, type Services } from '../../src/services.js'
import { attachWebSocket, WS_UNAUTHORIZED } from '../../src/sync/index.js'
import { catFile, identities, makeTempDir, removeDir } from '../helpers/git.js'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
// No daylight saving, so the expected dates below don't depend on when the test runs.
const TZ = 'Asia/Kolkata'
const TZ_OFFSET_MS = 5.5 * 60 * 60 * 1000
const FRAME_BYTES = 3_200 // 100 ms of 16 kHz PCM16
const RAW_NOTES = 'Dana wants SSO before rollout\n- pricing one-pager by Friday\n'

let root: string
let config: Config
let services: Services
let server: Server
let base: string
let respond: (req: LLMRequest) => string
let llm: FakeLLM
/** How many voices the fake transcriber tells apart on the call's side (0: just "Them"). */
let speakers = 0
/** Re-transcribes kept audio after the call; null (the fake ASR's default) means it doesn't. */
let retranscriber: MeetingRetranscriber | null = null

beforeEach(async () => {
  root = await makeTempDir('hearth-meetings-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
  })
  respond = () => 'unset'
  speakers = 0
  retranscriber = null
  await start()
})

afterEach(async () => {
  await stop()
  await removeDir(root)
})

/** The app as main.ts serves it: the API plus /ws and /ws/meetings/:id on a real port. */
async function start(): Promise<void> {
  llm = new FakeLLM((req) => respond(req))
  services = createServices(config, {
    llm,
    transcriber: new FakeTranscriber({ partials: true, speakers }),
    retranscriber,
    calendar: new FakeCalendar(),
    pushSender: new FakePushSender(),
  })
  await services.spaces.ensureTeamSpace()
  await services.meetings.sessions.recover()
  const app = new Hono()
  const inject = attachWebSocket(app, services.broadcaster, services.meetings.sockets)
  app.route('/', createApp(services))
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
  inject(server)
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function stop(): Promise<void> {
  // Sessions close their sockets first: an open WebSocket would keep the server from closing.
  await services.meetings.sessions.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  services.index.close()
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; status?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`http://${base}${path}`, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

type Message =
  | { type: 'ready'; sessionId: string; resumeFrom: Record<Track, number> }
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'state'; state: string }
  | { type: 'error'; message: string }

/** A browser's side of /ws/meetings/:id. */
class MeetingSocket {
  readonly messages: Message[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => this.messages.push(JSON.parse(String(e.data))))
    this.closed = new Promise((resolve) =>
      ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
    )
  }

  static async open(id: string): Promise<MeetingSocket> {
    const ws = new WebSocket(`ws://${base}/ws/meetings/${id}`)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    return new MeetingSocket(ws)
  }

  /** Opens, authenticates as `devUser`, and waits for `ready`. */
  static async connect(id: string, devUser = ALICE): Promise<MeetingSocket> {
    const socket = await MeetingSocket.open(id)
    socket.ws.send(JSON.stringify({ type: 'auth', devUser }))
    await vi.waitFor(() => expect(socket.ready).toBeDefined())
    return socket
  }

  get ready() {
    return this.messages.find((m) => m.type === 'ready')
  }

  finals(): TranscriptSegment[] {
    return this.messages.flatMap((m) =>
      m.type === 'segment' && m.segment.final ? [m.segment] : [],
    )
  }

  /** `seconds` of silence on each track, interleaved in 100 ms frames. */
  sendAudio(seconds: number, tracks: Track[] = ['me', 'them']): void {
    for (let i = 0; i < seconds * 10; i++) {
      for (const track of tracks) this.ws.send(audioFrame(track, new Uint8Array(FRAME_BYTES)))
    }
  }

  async close(): Promise<void> {
    this.ws.close()
    await this.closed
  }
}

const bare = (space: string) => join(root, 'remotes', `${space}.git`)
const readRemote = (space: string, path: string) => catFile(bare(space), 'main', path)
const lastMessage = async (space: string) =>
  (await runGit(bare(space), ['log', '-1', '--format=%s', 'main'])).trim()

/** The wall clock in TZ, as the note's frontmatter writes it. */
function inTz(iso: string): { date: string; day: string } {
  const local = new Date(Date.parse(iso) + TZ_OFFSET_MS).toISOString().slice(0, 19)
  return { date: `${local}+05:30`, day: local.slice(0, 10) }
}

async function createSession(body: Record<string, unknown> = {}): Promise<MeetingSession> {
  return api('POST', '/api/meetings/sessions', {
    json: {
      title: 'Acme sync',
      template: 'customer-call',
      calendarEventId: 'fake-acme-sync',
      tz: TZ,
      ...body,
    },
  })
}

describe('transcript cleanup after the call', () => {
  it('transcribes kept audio again before Enhance reads it, then keeps the audio', async () => {
    await stop()
    retranscriber = new FakeRetranscriber({ speakers: 2 })
    await start()
    const session = await createSession()
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(2)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(4))
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { keepAudio: true },
    })
    await socket.close()

    let prompt = ''
    respond = (req) => {
      prompt = req.messages.at(-1)?.content ?? ''
      return '## Summary\n- done'
    }
    // Straight after Stop, as the note page does: Enhance waits for the cleanup.
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    expect(prompt).toContain('**Speaker 2:** their tidy sentence 2')
    expect(prompt).not.toContain('segment')
    const transcript = await readRemote('alice', saved.transcriptPath)
    expect(transcript).toContain('[00:00:00] **Me:** my clean words 1')
    expect(transcript).toContain('[00:00:01] **Speaker 2:** their tidy sentence 2')
    expect(transcript).not.toContain('them segment')
    const log = await runGit(bare('alice'), ['log', '--format=%s', 'main'])
    expect(log).toContain('meetings: clean up transcript of "Acme sync"')
    // The live transcript is still in history.
    expect(
      await runGit(bare('alice'), ['log', '-p', '--format=%s', 'main', '--', saved.transcriptPath]),
    ).toContain('-[00:00:00] **Them:** them segment 1')
    // Both tracks were sent with the meeting's word list, and the audio was kept afterwards.
    const fake = retranscriber as FakeRetranscriber
    expect(fake.calls.map((c) => c.track).sort()).toEqual(['me', 'them'])
    expect(fake.calls[0]?.vocabulary).toContain('Dana Lee')
    await services.meetings.sessions.settled()
    expect(await readRemote('alice', `.hearth/meetings/audio/${session.id}.yaml`)).toContain(
      'me.wav',
    )
  })

  it('keeps the live transcript when re-transcribing fails', async () => {
    await stop()
    retranscriber = new FakeRetranscriber({ fail: true })
    await start()
    const session = await createSession()
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(1)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(2))
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { keepAudio: true },
    })
    await socket.close()
    await services.meetings.sessions.settled()
    expect(await readRemote('alice', saved.transcriptPath)).toContain('**Them:** them segment 1')
    expect(await readRemote('alice', `.hearth/meetings/audio/${session.id}.yaml`)).toContain(
      'them.wav',
    )
  })

  it('without kept audio, fixes names from the word list and nothing else', async () => {
    await api('PUT', '/api/dictation/words', { json: { scope: 'mine', words: ['Segmint'] } })
    respond = (req) => {
      const prompt = req.messages.at(-1)?.content ?? ''
      if (!prompt.includes('<cleanup_transcript>')) return '## Summary\n- done'
      return JSON.stringify([
        { line: 0, from: 'segment', to: 'segmint' },
        // Not on the word list, not on that line, or not a mishearing of it: all dropped.
        { line: 1, from: 'segment', to: 'Segments' },
        { line: 1, from: 'nowhere', to: 'Segmint' },
        { line: 1, from: 'them', to: 'Dana Lee' },
      ])
    }
    const session = await createSession()
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(1)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(2))
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, { json: {} })
    await socket.close()
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    const cleanupCall = llm.calls.find((c) =>
      c.messages.at(-1)?.content.includes('<cleanup_transcript>'),
    )
    expect(cleanupCall?.model).toBe(config.CLEANUP_MODEL)
    expect(cleanupCall?.messages.at(-1)?.content).toContain('\nDana Lee\n')
    expect(cleanupCall?.messages.at(-1)?.content).toContain('\nSegmint\n')
    const transcript = await readRemote('alice', saved.transcriptPath)
    expect(transcript).toContain('**Me:** me Segmint 1')
    expect(transcript).toContain('**Them:** them segment 1')
    expect(llm.calls.at(-1)?.messages.at(-1)?.content).toContain('me Segmint 1')
  })

  it('refuses to name speakers from a transcript the cleanup has since replaced', async () => {
    await stop()
    speakers = 2
    retranscriber = new FakeRetranscriber({ speakers: 2 })
    await start()
    const session = await createSession()
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(2)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(4))
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { keepAudio: true },
    })
    await socket.close()
    // What the panel loaded straight after Stop: the live transcript.
    const live = await api(
      'GET',
      `/api/spaces/alice/file?path=${encodeURIComponent(saved.transcriptPath)}`,
    )
    await services.meetings.sessions.settled()
    await api('POST', '/api/meetings/speakers', {
      json: {
        space: 'alice',
        path: saved.path,
        names: { 'Speaker 2': 'Dana Lee' },
        transcriptBlobOid: live.blobOid,
      },
      status: 409,
    })
    expect(await readRemote('alice', saved.transcriptPath)).not.toContain('Dana Lee')
  })
})

describe('import from Granola', () => {
  const rows = [
    {
      ref: 'g-1',
      title: 'Acme kickoff',
      date: '2026-03-04T15:30:00-05:00',
      notes: 'Dana wants SSO',
      summary: '- Ship SSO first',
      transcript: 'Me: Hi all\nThem: Hello there.',
    },
    {
      ref: 'g-2',
      title: 'Empty',
      date: '2026-03-05T10:00:00Z',
      notes: '',
      summary: '',
      transcript: '',
    },
  ]

  it('imports meetings into the personal space once, ready to enhance', async () => {
    const first = await api('POST', '/api/meetings/import/granola', {
      json: { meetings: rows, tz: 'America/New_York' },
    })
    expect(first).toEqual({ imported: 1, skipped: 1, space: 'alice' })
    expect(await lastMessage('alice')).toBe('meetings: import "1 from Granola"')
    const note = await readRemote('alice', 'meetings/2026/03/2026-03-04-acme-kickoff.md')
    expect(note).toContain('imported_from: granola')
    expect(note).toContain('## My notes\n\nDana wants SSO')
    expect(
      await readRemote('alice', 'meetings/2026/03/2026-03-04-acme-kickoff.transcript.md'),
    ).toContain('[00:00:00] **Them:** Hello there.')
    const list = await api('GET', '/api/meetings')
    expect(list.map((m: { title: string }) => m.title)).toContain('Acme kickoff')

    // Again: nothing new.
    const again = await api('POST', '/api/meetings/import/granola', {
      json: { meetings: rows, tz: 'America/New_York' },
    })
    expect(again).toEqual({ imported: 0, skipped: 2, space: 'alice' })

    // Hearth can enhance it without asking to replace edits: Granola's summary is AI text.
    let prompt = ''
    respond = (req) => {
      prompt = req.messages.at(-1)?.content ?? ''
      return '## Summary\n- Hearth summary'
    }
    await api('POST', '/api/meetings/enhance', {
      json: { space: 'alice', path: 'meetings/2026/03/2026-03-04-acme-kickoff.md' },
    })
    expect(prompt).toContain('Dana wants SSO')
    expect(prompt).toContain('Hello there.')
  })

  it('a meeting with only notes, dated without a zone, lands on its day and can be enhanced', async () => {
    const notesOnly = {
      ref: 'g-3',
      title: 'Late call',
      date: '2026-03-04 21:30',
      notes: 'Just my notes',
      summary: '',
      transcript: '',
    }
    await api('POST', '/api/meetings/import/granola', {
      json: { meetings: [notesOnly], tz: 'America/New_York' },
    })
    const path = 'meetings/2026/03/2026-03-04-late-call.md'
    expect(await readRemote('alice', path)).toMatch(/^date: '?2026-03-04T21:30:00-05:00'?$/m)
    respond = () => '## Summary\n- Hearth summary'
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path } })
    expect(await readRemote('alice', path)).toContain('Hearth summary')
  })

  it('refuses a batch that is too big or malformed', async () => {
    const tz = 'America/New_York'
    await api('POST', '/api/meetings/import/granola', { json: { meetings: [], tz }, status: 400 })
    await api('POST', '/api/meetings/import/granola', {
      json: { meetings: [{ ...rows[0], ref: '' }], tz },
      status: 400,
    })
    await api('POST', '/api/meetings/import/granola', {
      json: { meetings: rows, tz: 'Mars/Olympus' },
      status: 400,
    })
  })
})

describe('speakers on the call', () => {
  it('labels each voice, guesses names from attendees, and names them in transcript and note', async () => {
    await stop()
    speakers = 2
    await start()
    const session = await createSession()
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(2)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(4))
    expect(socket.finals().map((s) => [s.track, s.speaker])).toEqual([
      ['me', 'Me'],
      ['them', 'Speaker 1'],
      ['me', 'Me'],
      ['them', 'Speaker 2'],
    ])
    socket.ws.send(JSON.stringify({ type: 'notes', text: RAW_NOTES }))
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).rawNotes).toBe(RAW_NOTES),
    )
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, { json: {} })
    await socket.close()
    expect(await readRemote('alice', saved.transcriptPath)).toContain(
      '**Speaker 2:** them segment 2',
    )

    let prompt = ''
    respond = (req) => {
      prompt = req.messages[0]?.content ?? ''
      // Eve isn't an attendee, so that guess is dropped.
      return 'Speakers: Speaker 1 = Dana Lee; Speaker 2 = Eve\n\n## Summary\n- Speaker 1 wants SSO; Speaker 12 is not a label'
    }
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    expect(prompt).toMatch(/write one line "Speakers: "/)
    let note = await readRemote('alice', saved.path)
    expect(note).not.toContain('Speakers:')
    expect(note).toMatch(/speaker_guesses:\n {2}Speaker 1: Dana Lee\n/)
    expect(note).toContain('- Speaker 1 wants SSO; Speaker 12 is not a label')

    await api('POST', '/api/meetings/speakers', {
      json: { space: 'alice', path: saved.path, names: { 'Speaker 1': 'Dana Lee' } },
    })
    expect(await lastMessage('alice')).toBe('meetings: name speakers in "Acme sync"')
    const transcript = await readRemote('alice', saved.transcriptPath)
    expect(transcript).toContain('**Dana Lee:** them segment 1')
    expect(transcript).toContain('**Speaker 2:** them segment 2')
    expect(transcript).toContain('**Me:** me segment 1')
    note = await readRemote('alice', saved.path)
    expect(note).toContain('- Dana Lee wants SSO; Speaker 12 is not a label')
    // The member's own line keeps its words.
    expect(note).toContain('Dana wants SSO before rollout')
    expect(note).not.toContain('speaker_guesses')

    // Hearth's own rename doesn't count as the member editing the note.
    respond = () => '## Summary\n- again'
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })

    for (const names of [{ Me: 'Alice' }, { 'Speaker 9': 'Sam' }, { 'Speaker 2': '  ' }]) {
      await api('POST', '/api/meetings/speakers', {
        json: { space: 'alice', path: saved.path, names },
        status: 400,
      })
    }
    // Once the member edits the note, Claude's lines are no longer known: only the transcript
    // is renamed, and the note keeps every byte.
    const edited = `${await readRemote('alice', saved.path)}\nSpeaker 2 is my line\n`
    await api('PUT', '/api/spaces/alice/file', { json: { path: saved.path, content: edited } })
    await api('POST', '/api/meetings/speakers', {
      json: { space: 'alice', path: saved.path, names: { 'Speaker 2': 'Sam Ortiz' } },
    })
    expect(await readRemote('alice', saved.path)).toBe(edited)
    expect(await readRemote('alice', saved.transcriptPath)).toContain(
      '**Sam Ortiz:** them segment 2',
    )

    await api('POST', '/api/meetings/speakers', {
      as: BOB,
      json: { space: 'alice', path: saved.path, names: { 'Sam Ortiz': 'Sam' } },
      status: 403,
    })
  })
})

describe('a meeting from capture to chat', () => {
  it('records over a WebSocket, commits the files, enhances, refuses to clobber edits, and answers', async () => {
    // Capture.
    const session = await createSession()
    expect(session).toMatchObject({
      owner: ALICE,
      space: 'alice',
      title: 'Acme sync',
      template: 'customer-call',
      calendarEventId: 'fake-acme-sync',
      state: 'recording',
      rawNotes: '',
      segments: [],
    })
    const socket = await MeetingSocket.connect(session.id)
    expect(socket.messages.slice(0, 2)).toEqual([
      { type: 'ready', sessionId: session.id, resumeFrom: { me: 0, them: 0 } },
      { type: 'state', state: 'recording' },
    ])

    socket.sendAudio(3)
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(6))
    expect(socket.finals().map((s) => [s.track, s.speaker, s.at, s.text])).toEqual([
      ['me', 'Me', 0, 'me segment 1'],
      ['them', 'Them', 0, 'them segment 1'],
      ['me', 'Me', 1000, 'me segment 2'],
      ['them', 'Them', 1000, 'them segment 2'],
      ['me', 'Me', 2000, 'me segment 3'],
      ['them', 'Them', 2000, 'them segment 3'],
    ])
    // Partials arrive before their finals.
    expect(socket.messages.find((m) => m.type === 'segment' && !m.segment.final)).toBeDefined()

    socket.ws.send(JSON.stringify({ type: 'notes', text: RAW_NOTES }))
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).rawNotes).toBe(RAW_NOTES),
    )

    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, { json: {} })
    const { date, day } = inTz(session.startedAt)
    const [yyyy, mm] = day.split('-')
    const notePath = `meetings/${yyyy}/${mm}/${day}-acme-sync.md`
    const transcriptPath = `meetings/${yyyy}/${mm}/${day}-acme-sync.transcript.md`
    expect(saved).toEqual({ space: 'alice', path: notePath, transcriptPath })
    expect(await socket.closed).toEqual({ code: 1000, reason: 'saved' })
    expect(
      socket.messages.filter((m) => m.type === 'state').map((m) => m.type === 'state' && m.state),
    ).toEqual(['recording', 'stopped', 'saved'])

    // The three files, committed to Alice's personal repo, authored by her.
    expect((await readRemote('alice', notePath)).split('\n')).toEqual([
      '---',
      `id: ${session.id}`,
      'type: meeting',
      'title: Acme sync',
      `date: ${date}`,
      'duration_min: 0',
      'attendees:',
      `  - Alice <${ALICE}>`,
      '  - Dana Lee <dana@acme.com>',
      'companies:',
      '  - acme.com',
      'template: customer-call',
      'calendar_event_id: fake-acme-sync',
      'calendar_series_id: fake-acme-series',
      `transcript: ${day}-acme-sync.transcript.md`,
      'ai_ranges: []',
      'models: {}',
      '---',
      '# Acme sync',
      '',
      '## Summary',
      '',
      'Dana wants SSO before rollout',
      '- pricing one-pager by Friday',
      '',
      '## Their situation',
      '',
      '## Requirements and objections',
      '',
      '## Buying process',
      '',
      '## Next steps',
      '',
    ])
    expect((await readRemote('alice', transcriptPath)).split('\n')).toEqual([
      '# Acme sync: transcript',
      '',
      '[00:00:00] **Me:** me segment 1',
      '[00:00:00] **Them:** them segment 1',
      '[00:00:01] **Me:** me segment 2',
      '[00:00:01] **Them:** them segment 2',
      '[00:00:02] **Me:** me segment 3',
      '[00:00:02] **Them:** them segment 3',
      '',
    ])
    expect(await readRemote('alice', `.hearth/meetings/raw/${session.id}.md`)).toBe(RAW_NOTES)
    expect(await lastMessage('alice')).toBe('meetings: capture "Acme sync"')
    expect(await identities(bare('alice'), 'main')).toBe(
      `Alice <${ALICE}> | Hotsauce <hotsauce@hotsauce.invalid>`,
    )
    // Audio is gone once the transcript is saved; the session remembers where it went.
    const dir = join(config.DATA_DIR, 'sessions', session.id)
    expect(existsSync(join(dir, 'me.pcm')) || existsSync(join(dir, 'them.pcm'))).toBe(false)
    expect(await api('GET', `/api/meetings/sessions/${session.id}`)).toMatchObject({
      state: 'saved',
      saved,
    })

    // Listed from the index, with the transcript found.
    expect(await api('GET', '/api/meetings')).toEqual([
      {
        space: 'alice',
        path: notePath,
        title: 'Acme sync',
        date,
        duration_min: 0,
        attendees: [`Alice <${ALICE}>`, 'Dana Lee <dana@acme.com>'],
        companies: ['acme.com'],
        template: 'customer-call',
        hasTranscript: true,
      },
    ])

    // Enhance: the fake keeps the raw lines verbatim and adds bullets around them.
    respond = () =>
      [
        '## Summary',
        '',
        'Dana wants SSO before rollout',
        '- They need SAML with Okta',
        '- pricing one-pager by Friday',
        '',
        '## Next steps',
        '',
        '- [ ] Alice: send the pricing one-pager (Fri)',
      ].join('\n')
    const enhanced = await api('POST', '/api/meetings/enhance', {
      json: { space: 'alice', path: notePath },
    })
    const body = [
      '# Acme sync', // 1
      '', // 2
      '## Summary', // 3
      '', // 4
      'Dana wants SSO before rollout', // 5: Alice's
      '- They need SAML with Okta', // 6
      '- pricing one-pager by Friday', // 7: Alice's
      '', // 8
      '## Next steps', // 9
      '', // 10
      '- [ ] Alice: send the pricing one-pager (Fri)', // 11
    ]
    const aiRanges = [
      [1, 4],
      [6, 6],
      [8, 11],
    ]
    expect(enhanced).toEqual({ path: notePath, aiRanges, usage: expect.any(Object) })
    // Exactly the lines Alice didn't type are AI.
    const rawLines = RAW_NOTES.split('\n').filter(Boolean)
    body.forEach((line, i) => {
      const inRange = aiRanges.some(([a = 0, b = 0]) => i + 1 >= a && i + 1 <= b)
      expect(inRange, `line ${i + 1}: ${line}`).toBe(!rawLines.includes(line))
    })

    const note = await readRemote('alice', notePath)
    const [frontmatter = '', enhancedBody = ''] = note.split(/^---\n/m).slice(1)
    expect(enhancedBody.split('\n')).toEqual([...body, ''])
    expect(frontmatter).toContain('ai_ranges: [[1, 4], [6, 6], [8, 11]]\n')
    expect(frontmatter).toMatch(
      /\nmodels: \{enhance: claude-sonnet-5-5, enhanced_blob: [0-9a-f]{40}\}\n/,
    )
    expect(frontmatter).toContain('template: customer-call\n')
    expect(await lastMessage('alice')).toBe('meetings: enhance "Acme sync"')

    const prompt = llm.calls.at(-1)
    expect(prompt?.model).toBe('claude-sonnet-5-5')
    expect(prompt?.messages[0]?.content).toContain('## Their situation')
    expect(prompt?.messages[0]?.content).toContain('- Dana Lee <dana@acme.com>')
    expect(prompt?.messages[0]?.content).toContain('[00:00:02] **Them:** them segment 3')
    expect(prompt?.messages[0]?.content).toContain('Calendar description:\nAgenda: SSO timeline')

    // Re-enhancing an untouched note is fine; after an edit it needs force.
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: notePath } })
    const current = await api('GET', `/api/spaces/alice/file?path=${encodeURIComponent(notePath)}`)
    await api('PUT', '/api/spaces/alice/file', {
      json: {
        path: notePath,
        content: `${current.content}- A line Alice added by hand\n`,
        baseBlobOid: current.blobOid,
      },
    })
    const refused = await api('POST', '/api/meetings/enhance', {
      json: { space: 'alice', path: notePath },
      status: 409,
    })
    expect(refused.error.code).toBe('conflict')
    await api('POST', '/api/meetings/enhance', {
      json: { space: 'alice', path: notePath, force: true },
    })
    expect(await readRemote('alice', notePath)).not.toContain('A line Alice added by hand')

    // Chat about this meeting: the citation points at a real line.
    respond = (req) =>
      req.messages[0]?.content.includes('<excerpts>') ? 'She wants SSO first [1].' : ''
    const chat = await api('POST', '/api/meetings/chat', {
      json: {
        question: 'What did Dana want before rollout?',
        scope: { space: 'alice', meetingPath: notePath },
      },
    })
    expect(chat.answer).toBe('She wants SSO first [1].')
    expect(chat.citations).toHaveLength(1)
    const [citation] = chat.citations
    const cited = (await readRemote(citation.space, citation.path)).split('\n')
    expect(cited[citation.line - 1]).toBe(citation.text.split('\n')[0])
    expect(citation.text).toContain('Dana wants SSO before rollout')
    expect(llm.calls.at(-1)?.model).toBe('claude-opus-5-5')

    // And across every meeting Alice can see.
    const across = await api('POST', '/api/meetings/chat', {
      json: { question: 'SAML Okta', scope: {} },
    })
    expect(across.citations[0]).toMatchObject({ space: 'alice', path: notePath })
    const nothing = await api('POST', '/api/meetings/chat', {
      json: { question: 'zebrafish', scope: {} },
    })
    expect(nothing).toEqual({
      answer: "I couldn't find anything about that in your meetings.",
      citations: [],
    })
  })
})

describe('the audio socket', () => {
  it('resumes from the bytes it holds, and a newer connection replaces the older', async () => {
    const session = await createSession({ calendarEventId: undefined, title: 'Standup' })
    const first = await MeetingSocket.connect(session.id)
    first.sendAudio(1, ['me'])
    first.sendAudio(0.5, ['them'])
    await first.close()

    const second = await MeetingSocket.connect(session.id)
    expect(second.ready).toEqual({
      type: 'ready',
      sessionId: session.id,
      resumeFrom: { me: 32_000, them: 16_000 },
    })
    const third = await MeetingSocket.connect(session.id)
    expect(await second.closed).toEqual({
      code: WS_REPLACED,
      reason: 'replaced by a newer connection',
    })
    expect(third.ready).toMatchObject({ resumeFrom: { me: 32_000, them: 16_000 } })

    // The transcript carries on in the same timeline.
    third.sendAudio(0.5, ['them'])
    await vi.waitFor(() =>
      expect(third.finals().map((s) => [s.track, s.at])).toEqual([['them', 0]]),
    )
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    const transcript = await readRemote('alice', saved.transcriptPath)
    expect(transcript).toContain(
      '[00:00:00] **Me:** me segment 1\n[00:00:00] **Them:** them segment 1\n',
    )
  })

  it('saves the notes sent with Stop over a notes frame that arrives after it', async () => {
    const session = await createSession({ calendarEventId: undefined, title: 'Last words' })
    const socket = await MeetingSocket.connect(session.id)
    socket.ws.send(JSON.stringify({ type: 'notes', text: 'first draft' }))
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).rawNotes).toBe(
        'first draft',
      ),
    )

    const stopping = api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { notes: 'the last words typed\n' },
    })
    await vi.waitFor(() =>
      expect(socket.messages).toContainEqual({ type: 'state', state: 'stopped' }),
    )
    // The older notes, queued behind audio, reach the server after Stop began.
    socket.ws.send(JSON.stringify({ type: 'notes', text: 'first draft' }))
    const saved = await stopping

    expect(await readRemote('alice', `.hearth/meetings/raw/${session.id}.md`)).toBe(
      'the last words typed\n',
    )
    expect(await readRemote('alice', saved.path)).toContain('\nthe last words typed\n')
  })

  it('keeps the audio on request: a WAV per track, a pointer in Git, served to the owner only', async () => {
    expect(await api('GET', '/api/meetings/settings')).toEqual({
      keepAudio: { available: true, byDefault: false },
    })
    const session = await createSession({ calendarEventId: undefined, title: 'Keep it' })
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(10, ['me', 'them'])
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).segments).toHaveLength(20),
    )

    // Chosen while recording, so a stop that doesn't say (Save it now, say) still keeps it.
    await api('PUT', `/api/meetings/sessions/${session.id}/keep-audio`, {
      as: BOB,
      json: { keep: true },
      status: 403,
    })
    const chosen = await api('PUT', `/api/meetings/sessions/${session.id}/keep-audio`, {
      json: { keep: true },
    })
    expect(chosen.keepAudio).toBe(true)
    expect((await api('GET', `/api/meetings/sessions/${session.id}`)).keepAudio).toBe(true)
    await api('POST', `/api/meetings/sessions/${session.id}/stop`, { json: {} })
    await services.meetings.sessions.settled()

    const pointer = await readRemote('alice', `.hearth/meetings/audio/${session.id}.yaml`)
    expect(pointer).toContain(`key: meetings/alice/${session.id}/them.wav`)
    const query = `space=alice&id=${session.id}&track=them`
    const res = await fetch(`http://${base}/api/meetings/audio?${query}`, {
      headers: { 'x-hearth-dev-user': ALICE },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect((await res.arrayBuffer()).byteLength).toBe(100 * FRAME_BYTES + 44)
    await api('GET', `/api/meetings/audio?${query}`, { as: BOB, status: 403 })

    // Bob can write to the team space, but a pointer he commits there can't reach Alice's audio.
    await api('PUT', '/api/spaces/team/file', {
      as: BOB,
      json: { path: `.hearth/meetings/audio/${session.id}.yaml`, content: pointer },
    })
    await api('GET', `/api/meetings/audio?space=team&id=${session.id}&track=them`, {
      as: BOB,
      status: 404,
    })
  })

  it('remembers the Meet call a session records, and refuses anything that isn’t a Meet code', async () => {
    const session = await createSession({ calendarEventId: undefined, meetCode: 'abc-defg-hij' })
    expect(session.meetCode).toBe('abc-defg-hij')
    expect((await api('GET', `/api/meetings/sessions/${session.id}`)).meetCode).toBe('abc-defg-hij')
    await api('POST', '/api/meetings/sessions', {
      json: { title: 'Bad', meetCode: 'https://evil.example/' },
      status: 400,
    })
  })

  it('pauses and resumes over the socket and the API', async () => {
    const session = await createSession({ calendarEventId: undefined })
    const socket = await MeetingSocket.connect(session.id)
    socket.ws.send(JSON.stringify({ type: 'pause' }))
    await vi.waitFor(() =>
      expect(socket.messages.at(-1)).toEqual({ type: 'state', state: 'paused' }),
    )
    expect((await api('POST', `/api/meetings/sessions/${session.id}/resume`)).state).toBe(
      'recording',
    )
    await vi.waitFor(() =>
      expect(socket.messages.at(-1)).toEqual({ type: 'state', state: 'recording' }),
    )
    expect((await api('POST', `/api/meetings/sessions/${session.id}/pause`)).state).toBe('paused')
  })

  it('accepts, counts and transcribes audio that arrives while paused', async () => {
    const session = await createSession({ calendarEventId: undefined })
    const socket = await MeetingSocket.connect(session.id)
    // Paused over HTTP, say while the socket was down; the client then replays what it
    // recorded before the pause.
    expect((await api('POST', `/api/meetings/sessions/${session.id}/pause`)).state).toBe('paused')
    socket.sendAudio(1, ['me'])
    socket.sendAudio(0.5, ['them'])
    await vi.waitFor(() => expect(socket.finals().map((s) => [s.track, s.at])).toEqual([['me', 0]]))
    await socket.close()

    const again = await MeetingSocket.connect(session.id)
    expect(again.ready).toMatchObject({ resumeFrom: { me: 32_000, them: 16_000 } })
    expect(again.messages[1]).toEqual({ type: 'state', state: 'paused' })
  })

  it('rejects frames before auth, unknown users, other members, and unknown sessions', async () => {
    const session = await createSession()

    const early = await MeetingSocket.open(session.id)
    early.ws.send(audioFrame('me', new Uint8Array(FRAME_BYTES)))
    expect((await early.closed).code).toBe(WS_UNAUTHORIZED)

    const outsider = await MeetingSocket.open(session.id)
    outsider.ws.send(JSON.stringify({ type: 'auth', devUser: 'eve@example.com' }))
    expect((await outsider.closed).code).toBe(WS_UNAUTHORIZED)

    const bob = await MeetingSocket.open(session.id)
    bob.ws.send(JSON.stringify({ type: 'auth', devUser: BOB }))
    expect((await bob.closed).code).toBe(WS_FORBIDDEN)

    const missing = await MeetingSocket.open('01NOSUCHSESSION00000000000')
    missing.ws.send(JSON.stringify({ type: 'auth', devUser: ALICE }))
    expect((await missing.closed).code).toBe(WS_NOT_FOUND)

    const socket = await MeetingSocket.connect(session.id)
    socket.ws.send(new Uint8Array([7, 0, 0]))
    socket.ws.send(JSON.stringify({ type: 'dance' }))
    await vi.waitFor(() =>
      expect(
        socket.messages
          .filter((m) => m.type === 'error')
          .map((m) => m.type === 'error' && m.message),
      ).toEqual(['Audio frames start with a track byte: 0 me, 1 them', 'Unknown message']),
    )
  })

  it('drops a client that stops answering pings, freeing its session', async () => {
    const sockets = new MeetingSocketServer({
      auth: services.auth,
      sessions: services.meetings.sessions,
      publicUrl: `http://${base}`,
      heartbeatMs: 10,
    })
    /** A socket whose pings go unanswered unless `answers`; records what the server did to it. */
    const fakeSocket = (answers: boolean) => {
      const record = { sent: [] as Message[], closed: null as number | null, terminated: false }
      let handlers: ReturnType<MeetingSocketServer['connect']> | undefined
      const socket = {
        send: (data: string) => record.sent.push(JSON.parse(data)),
        close: (code: number) => {
          record.closed = code
        },
        ping: () => {
          if (answers) handlers?.pong()
        },
        terminate: () => {
          record.terminated = true
          handlers?.closed()
        },
      }
      return { record, socket, attach: (h: typeof handlers) => (handlers = h) }
    }
    const session = await createSession()
    const silent = fakeSocket(false)
    const silentHandlers = sockets.connect(session.id, silent.socket)
    silent.attach(silentHandlers)
    silentHandlers.text(JSON.stringify({ type: 'auth', devUser: ALICE }))
    await vi.waitFor(() => expect(silent.record.sent[0]?.type).toBe('ready'))
    const lively = fakeSocket(true)
    lively.attach(sockets.connect('01NOSUCHSESSION00000000000', lively.socket))

    sockets.start()
    try {
      await vi.waitFor(() => expect(silent.record.terminated).toBe(true))
      expect(lively.record.terminated).toBe(false)
    } finally {
      sockets.stop()
    }
    // Detached on the way out: a new connection takes over without "replacing" anyone.
    const next = await MeetingSocket.connect(session.id)
    expect(next.ready).toBeDefined()
    expect(silent.record.closed).toBeNull()
  })

  it("lists each member's own unsaved sessions, newest first", async () => {
    const first = await createSession({ calendarEventId: undefined, title: 'First' })
    const second = await createSession({ calendarEventId: undefined, title: 'Second' })
    const saved = await createSession({ calendarEventId: undefined, title: 'Saved' })
    await api('POST', `/api/meetings/sessions/${saved.id}/stop`)
    await api('GET', '/api/me', { as: BOB })
    const bobs = await api('POST', '/api/meetings/sessions', {
      as: BOB,
      json: { title: 'Bob alone', tz: TZ },
    })

    const alice = await api('GET', '/api/meetings/sessions')
    expect(alice.map((s: MeetingSession) => [s.id, s.title, s.state])).toEqual([
      [second.id, 'Second', 'recording'],
      [first.id, 'First', 'recording'],
    ])
    expect(alice[0]).toEqual(await api('GET', `/api/meetings/sessions/${second.id}`))
    const bob = await api('GET', '/api/meetings/sessions', { as: BOB })
    expect(bob.map((s: MeetingSession) => [s.id, s.owner])).toEqual([[bobs.id, BOB]])
  })

  it('gives another member 403 on every session route', async () => {
    const session = await createSession()
    await api('GET', '/api/me', { as: BOB })
    const id = session.id
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/api/meetings/sessions/${id}`],
      ['PUT', `/api/meetings/sessions/${id}/notes`, { text: 'mine now' }],
      ['POST', `/api/meetings/sessions/${id}/pause`],
      ['POST', `/api/meetings/sessions/${id}/resume`],
      ['POST', `/api/meetings/sessions/${id}/stop`, {}],
    ]
    for (const [method, path, json] of routes) {
      const body = await api(method, path, { as: BOB, status: 403, ...(json ? { json } : {}) })
      expect(body.error.code, `${method} ${path}`).toBe('forbidden')
    }
    await api('GET', '/api/meetings/sessions/01NOSUCHSESSION00000000000', { status: 404 })
    // Nothing Bob did reached the session.
    expect(await api('GET', `/api/meetings/sessions/${id}`)).toMatchObject({
      rawNotes: '',
      state: 'recording',
    })
  })
})

describe('recovery', () => {
  it('picks up an unsaved session after a restart, with its audio, transcript and notes', async () => {
    const session = await createSession({ calendarEventId: undefined, title: 'Board prep' })
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(2, ['me'])
    // Under a full parallel run transcription can take longer than waitFor's default second.
    await vi.waitFor(() => expect(socket.finals()).toHaveLength(2), { timeout: 5_000 })
    await api('PUT', `/api/meetings/sessions/${session.id}/notes`, {
      json: { text: 'Q4 numbers' },
      status: 204,
    })
    await socket.close()

    await stop()
    await start()

    expect(await api('GET', `/api/meetings/sessions/${session.id}`)).toMatchObject({
      state: 'recording',
      rawNotes: 'Q4 numbers',
      segments: [{ text: 'me segment 1' }, { text: 'me segment 2' }],
    })
    const resumed = await MeetingSocket.connect(session.id)
    expect(resumed.ready).toMatchObject({ resumeFrom: { me: 64_000, them: 0 } })
    resumed.sendAudio(1, ['me'])
    // A new transcriber after the restart: its times continue from the audio already held.
    await vi.waitFor(() => expect(resumed.finals().map((s) => s.at)).toEqual([2000]), {
      timeout: 5_000,
    })
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    expect((await readRemote('alice', saved.transcriptPath)).split('\n').slice(2, 5)).toEqual([
      '[00:00:00] **Me:** me segment 1',
      '[00:00:01] **Me:** me segment 2',
      '[00:00:02] **Me:** me segment 1',
    ])
  })
})

describe('templates, calendar and the meeting list', () => {
  it('lists built-in templates plus team and personal ones', async () => {
    await api('PUT', '/api/spaces/team/file', {
      json: {
        path: '.hearth/meetings/templates/retro.md',
        content: '---\nid: retro\nname: Retro\ndescription: Team retro\n---\n## Went well\n',
      },
    })
    const templates = await api('GET', '/api/meetings/templates')
    expect(templates).toHaveLength(9)
    expect(templates).toContainEqual({
      id: 'general',
      name: 'General',
      description: expect.any(String),
      source: 'builtin',
    })
    expect(templates).toContainEqual({
      id: 'retro',
      name: 'Retro',
      description: 'Team retro',
      source: 'team',
    })
    const session = await createSession({ template: 'retro', calendarEventId: undefined })
    expect(session.template).toBe('retro')
    const unknown = await api('POST', '/api/meetings/sessions', {
      json: { template: 'nope' },
      status: 400,
    })
    expect(unknown.error.code).toBe('bad_request')
  })

  it('subscribes and unsubscribes a browser for meeting reminders', async () => {
    expect(await api('GET', '/api/meetings/reminders')).toEqual({ publicKey: 'test-public-key' })
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p', auth: 'a' },
    }
    await api('POST', '/api/meetings/reminders', { json: { subscription }, status: 204 })
    expect(await services.meetings.reminderStore.subscribers()).toMatchObject([
      { principal: { email: ALICE }, subscription },
    ])
    // Another member can't remove it.
    await api('DELETE', '/api/meetings/reminders', {
      as: BOB,
      json: { endpoint: subscription.endpoint },
      status: 204,
    })
    expect(await services.meetings.reminderStore.subscribers()).toHaveLength(1)
    await api('DELETE', '/api/meetings/reminders', {
      json: { endpoint: subscription.endpoint },
      status: 204,
    })
    expect(await services.meetings.reminderStore.subscribers()).toEqual([])
    await api('POST', '/api/meetings/reminders', { json: { subscription: {} }, status: 400 })
    // The server POSTs to the endpoint, so it must be a browser push service.
    await api('POST', '/api/meetings/reminders', {
      json: { subscription: { ...subscription, endpoint: 'https://127.0.0.1/admin' } },
      status: 400,
    })
    expect(await services.meetings.reminderStore.subscribers()).toEqual([])
  })

  it("sends a test notification to the caller's own browsers only", async () => {
    const sender = services.meetings.pushSender as FakePushSender
    const sub = (id: string) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
      keys: { p256dh: 'p', auth: 'a' },
    })
    // Nothing subscribed yet: nothing sent, and that's not an error.
    expect(await api('POST', '/api/meetings/reminders/test')).toEqual({ sent: 0 })
    await api('POST', '/api/meetings/reminders', {
      json: { subscription: sub('phone') },
      status: 204,
    })
    await api('POST', '/api/meetings/reminders', {
      json: { subscription: sub('laptop') },
      status: 204,
    })
    await api('GET', '/api/me', { as: BOB })
    await api('POST', '/api/meetings/reminders', {
      as: BOB,
      json: { subscription: sub('bobs') },
      status: 204,
    })
    // The push service has dropped the laptop: it's forgotten, not counted.
    sender.gone.add(sub('laptop').endpoint)

    expect(await api('POST', '/api/meetings/reminders/test')).toEqual({ sent: 1 })
    expect(sender.sent).toEqual([
      {
        endpoint: sub('phone').endpoint,
        payload: expect.objectContaining({
          title: expect.stringContaining('Test'),
          url: '/settings',
        }),
      },
    ])
    expect(
      (await services.meetings.reminderStore.subscribers()).map((s) => s.subscription.endpoint),
    ).toEqual([sub('phone').endpoint, sub('bobs').endpoint])

    // An access token can't set off notifications.
    const { token } = await api('POST', '/api/tokens', {
      json: { name: 'script' },
      status: 201,
    })
    const res = await fetch(`http://${base}/api/meetings/reminders/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    expect(sender.sent).toHaveLength(1)
  })

  it('serves the fake calendar in dev mode', async () => {
    const events = await api('GET', '/api/calendar/upcoming')
    expect(events.map((e: { id: string }) => e.id)).toContain('fake-acme-sync')
    expect(events[0].attendees).toContainEqual({ email: ALICE, name: 'Alice' })
    const none = await api(
      'GET',
      '/api/calendar/upcoming?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z',
    )
    expect(none).toEqual([])
    await api('GET', '/api/calendar/upcoming?from=yesterday', { status: 400 })
  })

  it('filters the list by person, company, folder and date, within visible spaces', async () => {
    const session = await createSession()
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    const adHoc = await createSession({ calendarEventId: undefined, title: 'Solo think' })
    await api('POST', `/api/meetings/sessions/${adHoc.id}/stop`)

    const titles = async (query: string, as = ALICE) =>
      (await api('GET', `/api/meetings${query}`, { as })).map((m: { title: string }) => m.title)
    expect((await titles('')).sort()).toEqual(['Acme sync', 'Solo think'])
    // Person is a whole email and company a whole domain, either in any case.
    expect(await titles('?person=DANA@acme.com')).toEqual(['Acme sync'])
    expect(await titles('?person=dana')).toEqual([])
    expect(await titles('?person=na@acme.com')).toEqual([])
    expect(await titles('?company=ACME.com')).toEqual(['Acme sync'])
    expect(await titles('?company=acme')).toEqual([])
    expect(await titles('?folder=elsewhere')).toEqual([])
    expect((await titles(`?folder=${saved.path.split('/').slice(1, 3).join('/')}`)).length).toBe(2)
    expect(await titles('?to=2020-01-01T00:00:00Z')).toEqual([])
    expect(await titles('?space=team')).toEqual([])
    // Bob can't see Alice's meetings, or ask for her space.
    expect(await titles('', BOB)).toEqual([])
    await api('GET', '/api/meetings?space=alice', { as: BOB, status: 403 })
  })
})

describe('voice notes', () => {
  it('names a voice note from what was said, and deletes it with its transcript and audio', async () => {
    const session = await createSession({
      title: undefined,
      template: 'voice-note',
      calendarEventId: undefined,
    })
    expect(session.title).toMatch(/^\d{1,2}:\d{2} [AP]M Voice note$/)
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(2, ['me'])
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).segments).toHaveLength(2),
    )
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { keepAudio: true },
    })
    await services.meetings.sessions.settled()
    await socket.close()

    respond = scriptedResponse
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    expect(llm.calls.at(-1)?.messages.at(-1)?.content).toContain('This note has no title yet')
    const note = await readRemote('alice', saved.path)
    expect(note).toMatch(/^title: About me segment 1$/m)
    expect(note).toContain('\n# About me segment 1\n')
    expect(note).toContain('## To-dos')
    expect(await lastMessage('alice')).toBe('meetings: enhance "About me segment 1"')
    // Named once: enhancing again keeps the title it was given.
    await api('POST', '/api/meetings/enhance', { json: { space: 'alice', path: saved.path } })
    expect(llm.calls.at(-1)?.messages.at(-1)?.content).not.toContain('This note has no title yet')
    expect(await readRemote('alice', saved.path)).toMatch(/^title: About me segment 1$/m)

    const pointer = `.hearth/meetings/audio/${session.id}.yaml`
    expect(await readRemote('alice', pointer)).toContain('me.wav')
    await api('POST', '/api/meetings/delete', {
      as: BOB,
      json: { space: 'alice', path: saved.path },
      status: 403,
    })
    const result = await api('POST', '/api/meetings/delete', {
      json: { space: 'alice', path: saved.path },
    })
    expect(result.deleted).toEqual(
      expect.arrayContaining([saved.path, saved.transcriptPath, pointer]),
    )
    expect(await lastMessage('alice')).toBe('meetings: delete "About me segment 1"')
    for (const path of [saved.path, saved.transcriptPath, pointer]) {
      await expect(readRemote('alice', path)).rejects.toThrow()
    }
    expect(
      await services.meetings.audioStore?.get(`meetings/alice/${session.id}/me.wav`),
    ).toBeNull()
    // Gone from the list, and deleting again finds nothing.
    expect((await api('GET', '/api/meetings')).map((m: { path: string }) => m.path)).not.toContain(
      saved.path,
    )
    await api('POST', '/api/meetings/delete', {
      json: { space: 'alice', path: saved.path },
      status: 404,
    })
  })

  it('deleting straight after Stop keeps no audio, even while it is still uploading', async () => {
    const session = await createSession({ template: 'voice-note', calendarEventId: undefined })
    const socket = await MeetingSocket.connect(session.id)
    socket.sendAudio(1, ['me'])
    await vi.waitFor(async () =>
      expect((await api('GET', `/api/meetings/sessions/${session.id}`)).segments).toHaveLength(1),
    )
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`, {
      json: { keepAudio: true },
    })
    await socket.close()
    // No settled(): the upload may not have started, or be half way.
    await api('POST', '/api/meetings/delete', { json: { space: 'alice', path: saved.path } })
    await services.meetings.sessions.settled()
    await expect(readRemote('alice', `.hearth/meetings/audio/${session.id}.yaml`)).rejects.toThrow()
    expect(
      await services.meetings.audioStore?.get(`meetings/alice/${session.id}/me.wav`),
    ).toBeNull()
  })

  it('deletes only a transcript beside the note, never Hearth files or another note', async () => {
    const id = '01JAAAAAAAAAAAAAAAAAAAAAAA'
    const meetingNote = (transcript: string) =>
      `---\nid: ${id}\ntype: meeting\ntitle: t\ndate: 2026-11-11T10:00:00Z\ntranscript: ${transcript}\n---\n# t\n`
    const other = '---\nid: 01JBBBBBBBBBBBBBBBBBBBBBBB\ntype: meeting\ntitle: o\ndate: d\n---\n'
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: 'meetings/x/other.transcript.md', content: other },
    })
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: 'meetings/x/sibling.md', content: '# Sibling\n' },
    })
    const aims = [
      '../../.hearth/space.yaml',
      '.hearth/space.yaml',
      'sibling.md',
      'other.transcript.md',
    ]
    for (const transcript of aims) {
      await api('PUT', '/api/spaces/alice/file', {
        json: { path: 'meetings/x/evil.md', content: meetingNote(transcript) },
      })
      const res = await api('POST', '/api/meetings/delete', {
        json: { space: 'alice', path: 'meetings/x/evil.md' },
      })
      expect(res.deleted, transcript).toEqual(['meetings/x/evil.md'])
    }
    expect(await readRemote('alice', '.hearth/space.yaml')).toContain('kind: personal')
    expect(await readRemote('alice', 'meetings/x/sibling.md')).toContain('# Sibling')
    expect(await readRemote('alice', 'meetings/x/other.transcript.md')).toContain('title: o')
  })

  it('refuses to delete a note that changed since the member opened it', async () => {
    const session = await createSession({ template: 'voice-note', calendarEventId: undefined })
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    const seen = await api('GET', `/api/spaces/alice/file?path=${encodeURIComponent(saved.path)}`)
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: saved.path, content: `${seen.content}edited\n`, baseBlobOid: seen.blobOid },
    })
    await api('POST', '/api/meetings/delete', {
      json: { space: 'alice', path: saved.path, blobOid: seen.blobOid },
      status: 409,
    })
    expect(await readRemote('alice', saved.path)).toContain('edited')
  })

  it('refuses to delete a file that is not a meeting note', async () => {
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: 'docs/plain.md', content: '# Plain\n' },
    })
    await api('POST', '/api/meetings/delete', {
      json: { space: 'alice', path: 'docs/plain.md' },
      status: 400,
    })
  })
})

describe('action items', () => {
  it("lists open items from the member's meetings and ticks one with a commit", async () => {
    const session = await createSession()
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    const file = await api('GET', `/api/spaces/alice/file?path=${encodeURIComponent(saved.path)}`)
    const content = `${file.content}\n## Action items\n\n- [ ] Alice: send the deck\n- [x] Done already\n\n\`\`\`\n- [ ] not a task, code\n\`\`\`\n`
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: saved.path, content, baseBlobOid: file.blobOid },
    })
    const line = content.split('\n').indexOf('- [ ] Alice: send the deck') + 1

    const list = await api('GET', '/api/meetings/action-items')
    expect(list).toEqual([
      {
        space: 'alice',
        path: saved.path,
        title: 'Acme sync',
        date: expect.any(String),
        items: [{ line, text: 'Alice: send the deck' }],
      },
    ])
    // Bob sees none of Alice's, and can't tick hers.
    expect(await api('GET', '/api/meetings/action-items', { as: BOB })).toEqual([])
    const tick = { space: 'alice', path: saved.path, line, text: 'Alice: send the deck' }
    await api('POST', '/api/meetings/action-items/done', { as: BOB, json: tick, status: 403 })
    // A line that no longer holds the item is a conflict, not a blind write.
    await api('POST', '/api/meetings/action-items/done', {
      json: { ...tick, line: line + 1 },
      status: 409,
    })

    await api('POST', '/api/meetings/action-items/done', { json: tick })
    const after = (await readRemote('alice', saved.path)).split('\n')
    expect(after[line - 1]).toBe('- [x] Alice: send the deck')
    expect(await lastMessage('alice')).toBe('meetings: complete "Alice: send the deck"')
    expect(await api('GET', '/api/meetings/action-items')).toEqual([])
    // Ticking it again is a conflict: it's no longer open.
    await api('POST', '/api/meetings/action-items/done', { json: tick, status: 409 })
  })

  it('ticks two adjacent items sent at once, with no conflict branch', async () => {
    const session = await createSession()
    const saved = await api('POST', `/api/meetings/sessions/${session.id}/stop`)
    const file = await api('GET', `/api/spaces/alice/file?path=${encodeURIComponent(saved.path)}`)
    const content = `${file.content}\n- [ ] first\n- [ ] second\n`
    await api('PUT', '/api/spaces/alice/file', {
      json: { path: saved.path, content, baseBlobOid: file.blobOid },
    })
    const lines = content.split('\n')
    const tick = (text: string) =>
      api('POST', '/api/meetings/action-items/done', {
        json: { space: 'alice', path: saved.path, line: lines.indexOf(`- [ ] ${text}`) + 1, text },
      })
    await Promise.all([tick('first'), tick('second')])
    const after = await readRemote('alice', saved.path)
    expect(after).toContain('- [x] first\n- [x] second\n')
    expect(await api('GET', '/api/spaces/alice/conflicts')).toEqual([])
  })
})

describe('configuration', () => {
  it('refuses the fake transcriber and language model in production', () => {
    const production = {
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_live',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      DEEPGRAM_API_KEY: 'dg',
      ANTHROPIC_API_KEY: 'sk-ant',
    }
    expect(() => loadConfig({ ...production, ASR_PROVIDER: 'fake' })).toThrow(/ASR_PROVIDER/)
    expect(() => loadConfig({ ...production, LLM_PROVIDER: 'fake' })).toThrow(/LLM_PROVIDER/)
    expect(loadConfig(production)).toMatchObject({
      ASR_PROVIDER: 'deepgram',
      LLM_PROVIDER: 'anthropic',
    })
  })

  it('keeps audio in R2 when its keys are set, and on the data volume otherwise', () => {
    const production = {
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_live',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      DEEPGRAM_API_KEY: 'dg',
      ANTHROPIC_API_KEY: 'sk-ant',
    }
    const r2 = {
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'hearth-audio',
    }
    expect(loadConfig(production).AUDIO_STORE).toBe('local')
    expect(loadConfig({ ...production, ...r2 }).AUDIO_STORE).toBe('r2')
    expect(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev' }).AUDIO_STORE).toBe('local')
    expect(() => loadConfig({ ...production, AUDIO_STORE: 'r2' })).toThrow(/R2_BUCKET/)
    expect(() => loadConfig({ ...production, AUDIO_STORE: 'none', KEEP_AUDIO: 'true' })).toThrow(
      /KEEP_AUDIO/,
    )
  })
})
