import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { parseFrontmatter } from '@hearth/format'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { Change, CommitResult } from '../git/index.js'
import { type AudioStore, LocalAudioStore } from './audio/index.js'
import { FakeCalendar } from './calendar/fake.js'
import { audioFrame } from './frames.js'
import {
  MAX_OPEN_SESSIONS,
  MeetingSessions,
  type MeetingSessionsOptions,
  meetingVocabulary,
} from './sessions.js'
import { loadBuiltinTemplates } from './templates.js'
import { FakeTranscriber } from './transcriber/fake.js'
import type { Transcriber } from './transcriber/types.js'

const ALICE: Principal = {
  userId: 'dev:alice@example.test',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}

/** The personal space as files at HEAD; a commit can be made to fail after it lands locally. */
class MemoryRepo {
  readonly files = new Map<string, string>()
  commits = 0
  failNextPush = false
  last: { author: { name: string; email: string }; message: string } | null = null

  async readFile(_space: string, path: string): Promise<{ content: string; blobOid: string }> {
    const content = this.files.get(path)
    if (content === undefined) throw new HearthError('not_found', path)
    return { content, blobOid: 'blob' }
  }

  async commit(
    _space: string,
    args: { changes: Change[]; author: { name: string; email: string }; message: string },
  ): Promise<CommitResult> {
    // Long enough for a concurrent stop to look for free paths meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const change of args.changes) this.files.set(change.path, String(change.content))
    this.commits++
    this.last = { author: args.author, message: args.message }
    if (this.failNextPush) {
      this.failNextPush = false
      throw new HearthError('push_failed', 'the host rejected the push')
    }
    return { status: 'committed', oid: 'commit', blobOid: 'blob' }
  }

  notes(): string[] {
    return [...this.files.keys()]
      .filter((p) => p.endsWith('.md') && !p.includes('.transcript.') && p.startsWith('meetings/'))
      .sort()
  }
}

let dir: string
let repo: MemoryRepo
let sessions: MeetingSessions
/** The sessions' clock, in ms; tests move it instead of waiting. */
let clock: number
const general = loadBuiltinTemplates().find((t) => t.id === 'general')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hearth-sessions-'))
  repo = new MemoryRepo()
  clock = Date.now()
  sessions = openSessions()
})

afterEach(async () => {
  await sessions.close()
  await rm(dir, { recursive: true, force: true })
})

/** Sessions over `dir` and `repo`, as one server process would hold them. */
function openSessions(
  audioStore: AudioStore | null = null,
  opts: Partial<MeetingSessionsOptions> = {},
): MeetingSessions {
  return new MeetingSessions({
    dataDir: dir,
    git: repo,
    afterCommit: async () => {},
    transcriber: new FakeTranscriber(),
    templates: {
      getTemplate: async () => {
        if (!general) throw new Error('general template missing')
        return general
      },
    },
    calendar: new FakeCalendar(),
    spaces: {
      visibleSpaces: async () => [
        { name: 'team', kind: 'team', label: 'Team' },
        { name: 'alice', kind: 'personal', label: 'Personal' },
      ],
    },
    internalDomains: ['example.test'],
    keepAudio: false,
    audioStore,
    now: () => new Date(clock),
    ...opts,
  })
}

describe('MeetingSessions.stop', () => {
  it('retried after a failed push, rewrites the same files instead of saving a second copy', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    repo.failNextPush = true
    await expect(sessions.stop(session.id)).rejects.toMatchObject({ code: 'push_failed' })
    expect(sessions.get(session.id, ALICE).state).toBe('stopped')

    const saved = await sessions.stop(session.id)

    expect(repo.commits).toBe(2)
    expect(repo.notes()).toEqual([saved.path])
    expect(saved.path).toMatch(/-standup\.md$/)
    expect(sessions.get(session.id, ALICE)).toMatchObject({ state: 'saved', saved })
    // Saved is final: stopping again changes nothing.
    expect(await sessions.stop(session.id)).toEqual(saved)
    expect(repo.commits).toBe(2)
  })

  it('gives two same-titled meetings stopped together their own files', async () => {
    const first = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    const second = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })

    const [a, b] = await Promise.all([sessions.stop(first.id), sessions.stop(second.id)])

    // Which stop reaches the path choice first is a race; what matters is that they never
    // share a file and each file carries its own session.
    const names = [a.path, b.path].map((p) =>
      p.replace(/^meetings\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-/, ''),
    )
    expect(names.sort()).toEqual(['standup-2.md', 'standup.md'])
    expect(a.transcriptPath).toBe(a.path.replace(/\.md$/, '.transcript.md'))
    expect(b.transcriptPath).toBe(b.path.replace(/\.md$/, '.transcript.md'))
    const idOf = (path: string) => parseFrontmatter(repo.files.get(path) ?? '').data.id
    expect([idOf(a.path), idOf(b.path)]).toEqual([first.id, second.id])
  })

  it('saves the notes Stop carries, and refuses notes sent after Stop began', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    await sessions.setRawNotes(session.id, 'first draft')

    const stopping = sessions.stop(session.id, { notes: 'the last words typed' })
    // A notes frame queued behind audio arrives after the stop began.
    await expect(sessions.setRawNotes(session.id, 'first draft')).rejects.toMatchObject({
      code: 'conflict',
    })
    const saved = await stopping

    expect(repo.files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe('the last words typed')
    expect(repo.files.get(saved.path)).toContain('\nthe last words typed\n')
  })

  it('refuses notes, pause and audio once stopped, and is owner-only', async () => {
    const session = await sessions.create(ALICE, { tz: 'UTC' })
    expect(session.title).toMatch(/^\d{1,2}:\d{2} [AP]M Meeting$/)
    await sessions.stop(session.id)
    await expect(sessions.setRawNotes(session.id, 'late')).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(sessions.pause(session.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      sessions.attachAudio(session.id, { send: () => {}, close: () => {} }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(() => sessions.get(session.id, { ...ALICE, email: 'bob@example.test' })).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    )
    await expect(sessions.create(ALICE, { tz: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'bad_request',
    })
  })
})

describe('MeetingSessions limits', () => {
  it('refuses a fourth open meeting for one member, and counts only open ones', async () => {
    const open = []
    for (let i = 0; i < MAX_OPEN_SESSIONS; i++) open.push(await sessions.create(ALICE, {}))
    await expect(sessions.create(ALICE, {})).rejects.toMatchObject({ code: 'conflict' })
    await sessions.stop(open[0]?.id ?? '')
    await expect(sessions.create(ALICE, {})).resolves.toBeDefined()
  })

  it('holds the cap against requests sent at once', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => sessions.create(ALICE, {})),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_OPEN_SESSIONS)
  })

  it('drops audio beyond real time plus slack, and says so', async () => {
    const session = await sessions.create(ALICE, {})
    const sent: unknown[] = []
    const connection = await sessions.attachAudio(session.id, {
      send: (m) => void sent.push(m),
      close: () => {},
    })
    // Ten minutes of slack at 32 bytes/ms is 19.2 MB; 20 frames of 1 MB overrun it.
    for (let i = 0; i < 20; i++) connection.audio(audioFrame('me', new Uint8Array(1_000_000)))
    const again = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    expect(again.resumeFrom.me).toBe(19_000_000)
    expect(sent.filter((m) => (m as { type: string }).type === 'error')).toEqual([
      { type: 'error', message: expect.stringMatching(/More audio/) },
    ])
  })
})

describe('MeetingSessions memory', () => {
  it('keeps only where a saved meeting went, and stays idempotent', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('me', new Uint8Array(32_000)))
    await sessions.setRawNotes(session.id, 'SSO first')
    expect(sessions.get(session.id, ALICE)).toMatchObject({
      rawNotes: 'SSO first',
      segments: [{ text: 'me segment 1' }],
    })

    const saved = await sessions.stop(session.id)

    // The transcript and notes are committed; memory holds only the record of where.
    expect(sessions.get(session.id, ALICE)).toEqual({
      id: session.id,
      owner: ALICE.email,
      space: 'alice',
      title: 'Standup',
      template: 'general',
      startedAt: session.startedAt,
      state: 'saved',
      rawNotes: '',
      segments: [],
      saved,
    })
    expect(repo.files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe('SSO first')
    expect(await sessions.stop(session.id)).toEqual(saved)
    expect(repo.commits).toBe(1)
  })
})

describe('MeetingSessions lifetime', () => {
  /** A socket that records how the server closed it. */
  const recordingSocket = () => {
    const closed: Array<[number, string]> = []
    const socket = {
      send: () => {},
      close: (code: number, reason: string) => {
        closed.push([code, reason])
      },
    }
    return { socket, closed }
  }

  it('saves a session nobody has been connected to for longer than the idle limit, as its owner would', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    await sessions.setRawNotes(session.id, 'SSO first')
    clock += 120 * MINUTE
    await sessions.sweep()
    expect(sessions.get(session.id, ALICE).state).toBe('recording')

    clock += MINUTE
    await sessions.sweep()

    expect(sessions.get(session.id, ALICE).state).toBe('saved')
    expect(repo.last).toEqual({
      author: { name: 'Alice', email: ALICE.email },
      message: 'meetings: capture "Standup"',
    })
    expect(repo.files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe('SSO first')
  })

  it('leaves a connected session alone, and counts idle time from when its socket went', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, recordingSocket().socket)
    clock += 3 * HOUR
    await sessions.sweep()
    expect(sessions.get(session.id, ALICE).state).toBe('recording')

    connection.detach()
    clock += 120 * MINUTE
    await sessions.sweep()
    expect(sessions.get(session.id, ALICE).state).toBe('recording')
    clock += MINUTE
    await sessions.sweep()
    expect(sessions.get(session.id, ALICE).state).toBe('saved')
  })

  it('stops a session older than the maximum even while connected, and closes its socket', async () => {
    const session = await sessions.create(ALICE, { title: 'Offsite', tz: 'UTC' })
    const { socket, closed } = recordingSocket()
    await sessions.attachAudio(session.id, socket)
    clock += 8 * HOUR
    await sessions.sweep()
    expect(sessions.get(session.id, ALICE).state).toBe('recording')

    clock += MINUTE
    await sessions.sweep()

    expect(sessions.get(session.id, ALICE).state).toBe('saved')
    expect(closed).toEqual([[1000, 'saved']])
    expect(repo.last?.message).toBe('meetings: capture "Offsite"')
  })

  it('saves at recovery a session abandoned before the restart, and keeps a recent one', async () => {
    const abandoned = await sessions.create(ALICE, { title: 'Abandoned', tz: 'UTC' })
    const recent = await sessions.create(ALICE, { title: 'Recent', tz: 'UTC' })
    await sessions.close()

    // The server is back three hours later; the recent session was written to just before.
    clock += 3 * HOUR
    const justBefore = new Date(clock - MINUTE)
    const recentDir = join(dir, 'sessions', recent.id)
    for (const name of await readdir(recentDir)) {
      await utimes(join(recentDir, name), justBefore, justBefore)
    }
    sessions = openSessions()

    expect(await sessions.recover()).toBe(2)

    expect(sessions.get(abandoned.id, ALICE).state).toBe('saved')
    expect(sessions.get(recent.id, ALICE).state).toBe('recording')
    expect(repo.notes()).toEqual([expect.stringMatching(/-abandoned\.md$/)])
  })

  it('sweeps every minute once recovered, until closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await sessions.recover()
      const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
      clock += 121 * MINUTE
      vi.advanceTimersByTime(MINUTE)
      await vi.waitFor(() => expect(sessions.get(session.id, ALICE).state).toBe('saved'))
      await sessions.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A local store whose first `failures` uploads fail, as R2 might. */
class FlakyStore extends LocalAudioStore {
  failures = 0
  puts = 0
  override async put(key: string, body: Readable, size: number): Promise<void> {
    this.puts += 1
    if (this.failures > 0) {
      this.failures -= 1
      body.destroy()
      throw new Error('R2 is down')
    }
    await super.put(key, body, size)
  }
}

describe('MeetingSessions kept audio', () => {
  it('uploads each track as WAV, commits a pointer, then deletes the PCM', async () => {
    await sessions.close()
    const store = new LocalAudioStore(join(dir, 'store'))
    sessions = openSessions(store)
    const session = await sessions.create(ALICE, { title: 'Acme sync', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('me', new Uint8Array(32_000).fill(7)))

    const saved = await sessions.stop(session.id, { keepAudio: true })
    await sessions.settled()

    const key = `meetings/alice/${session.id}/me.wav`
    const wav = await readFile(join(dir, 'store', 'kept-audio', key))
    expect(wav.length).toBe(32_044)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.readUInt32LE(40)).toBe(32_000)
    expect(wav[44]).toBe(7)
    const pointer = repo.files.get(`.hearth/meetings/audio/${session.id}.yaml`) ?? ''
    expect(pointer).toContain(`note: ${saved.path}`)
    expect(pointer).toContain(`key: ${key}`)
    expect(pointer).not.toContain('them:')
    expect(repo.last?.message).toBe('meetings: keep audio "Acme sync"')
    expect(await readdir(join(dir, 'sessions', session.id))).toEqual(['meta.json'])
  })

  it('keeps the PCM when an upload fails, and the sweep tries again ten minutes later', async () => {
    await sessions.close()
    const store = new FlakyStore(join(dir, 'store'))
    store.failures = 1
    sessions = openSessions(store)
    await sessions.recover()
    const session = await sessions.create(ALICE, { title: 'Flaky', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('me', new Uint8Array(3_200).fill(1)))
    await sessions.stop(session.id, { keepAudio: true })
    await sessions.settled()

    expect(repo.files.has(`.hearth/meetings/audio/${session.id}.yaml`)).toBe(false)
    expect(await readdir(join(dir, 'sessions', session.id))).toContain('me.pcm')
    clock += 5 * MINUTE
    await sessions.sweep()
    await sessions.settled()
    expect(store.puts).toBe(1)

    clock += 6 * MINUTE
    await sessions.sweep()
    await sessions.settled()
    expect(store.puts).toBe(2)
    expect(repo.files.has(`.hearth/meetings/audio/${session.id}.yaml`)).toBe(true)
    expect(await readdir(join(dir, 'sessions', session.id))).toEqual(['meta.json'])
  })

  it('finishes an upload a previous process didn’t, at the next startup', async () => {
    await sessions.close()
    const store = new FlakyStore(join(dir, 'store'))
    store.failures = 1
    sessions = openSessions(store)
    const session = await sessions.create(ALICE, { title: 'Deployed mid-upload', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('them', new Uint8Array(3_200).fill(2)))
    await sessions.stop(session.id, { keepAudio: true })
    await sessions.settled()
    await sessions.close()
    expect(repo.files.has(`.hearth/meetings/audio/${session.id}.yaml`)).toBe(false)

    sessions = openSessions(store)
    expect(await sessions.recover()).toBe(0)
    await sessions.settled()
    expect(repo.files.get(`.hearth/meetings/audio/${session.id}.yaml`)).toContain(
      `key: meetings/alice/${session.id}/them.wav`,
    )
    expect(await readdir(join(dir, 'sessions', session.id))).toEqual(['meta.json'])
    const meta = JSON.parse(await readFile(join(dir, 'sessions', session.id, 'meta.json'), 'utf8'))
    expect(meta.audioPending).toBeUndefined()
  })

  it('keeps the audio when the member chose it while recording, however the meeting ends', async () => {
    await sessions.close()
    const store = new LocalAudioStore(join(dir, 'store'))
    sessions = openSessions(store)
    await sessions.recover()
    const chosen = await sessions.create(ALICE, { title: 'Chosen', tz: 'UTC' })
    expect(chosen.keepAudio).toBeUndefined()
    expect((await sessions.setKeepAudio(chosen.id, true)).keepAudio).toBe(true)
    const connection = await sessions.attachAudio(chosen.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('me', new Uint8Array(3_200).fill(3)))
    connection.detach()

    // Saved by the idle sweep, with no Keep audio in the stop.
    clock += 3 * 60 * MINUTE
    await sessions.sweep()
    await sessions.settled()
    expect(repo.files.get(`.hearth/meetings/audio/${chosen.id}.yaml`)).toContain(
      `key: meetings/alice/${chosen.id}/me.wav`,
    )

    // Turned off again: a stop without a choice drops it, though the server's default is on.
    await sessions.close()
    sessions = openSessions(store, { keepAudio: true })
    const declined = await sessions.create(ALICE, { title: 'Declined', tz: 'UTC' })
    await sessions.setKeepAudio(declined.id, true)
    await sessions.setKeepAudio(declined.id, false)
    const again = await sessions.attachAudio(declined.id, { send: () => {}, close: () => {} })
    again.audio(audioFrame('me', new Uint8Array(3_200).fill(4)))
    await sessions.stop(declined.id)
    await sessions.settled()
    expect(repo.files.has(`.hearth/meetings/audio/${declined.id}.yaml`)).toBe(false)
    expect(await readdir(join(dir, 'sessions', declined.id))).toEqual(['meta.json'])
  })

  it('keeps the audio when a stop that asked for it failed and a later one doesn’t say', async () => {
    await sessions.close()
    const store = new LocalAudioStore(join(dir, 'store'))
    sessions = openSessions(store)
    const session = await sessions.create(ALICE, { title: 'Push failed', tz: 'UTC' })
    const connection = await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    connection.audio(audioFrame('me', new Uint8Array(3_200).fill(5)))
    repo.failNextPush = true
    await expect(sessions.stop(session.id, { keepAudio: true })).rejects.toMatchObject({
      code: 'push_failed',
    })

    // A restart in between: the choice was written with the session.
    await sessions.close()
    sessions = openSessions(store)
    await sessions.recover()
    await sessions.stop(session.id) // Save it now
    await sessions.settled()
    expect(repo.files.get(`.hearth/meetings/audio/${session.id}.yaml`)).toContain(
      `key: meetings/alice/${session.id}/me.wav`,
    )
  })

  it('records the Meet call a session is for', async () => {
    const session = await sessions.create(ALICE, {
      title: 'From the extension',
      tz: 'UTC',
      meetCode: 'abc-defg-hij',
    })
    expect(session.meetCode).toBe('abc-defg-hij')
    await sessions.close()
    sessions = openSessions()
    await sessions.recover()
    expect(sessions.get(session.id, ALICE).meetCode).toBe('abc-defg-hij')
  })

  it('refuses to keep audio when no store is set up, and drops it by default', async () => {
    const session = await sessions.create(ALICE, { title: 'Standup', tz: 'UTC' })
    expect(sessions.canKeepAudio).toBe(false)
    await expect(sessions.stop(session.id, { keepAudio: true })).rejects.toMatchObject({
      code: 'bad_request',
    })
    await expect(sessions.setKeepAudio(session.id, true)).rejects.toMatchObject({
      code: 'bad_request',
    })
    await sessions.stop(session.id)
    expect([...repo.files.keys()].some((p) => p.includes('/audio/'))).toBe(false)
  })
})

describe('meeting vocabulary', () => {
  it('sends attendee names and the member’s word lists to the transcriber, and keeps them across a restart', async () => {
    const started: Array<Parameters<Transcriber['start']>[0]> = []
    const fake = new FakeTranscriber()
    const transcriber: Transcriber = {
      start: (opts) => {
        started.push(opts)
        return fake.start(opts)
      },
    }
    await sessions.close()
    sessions = openSessions(null, { transcriber, keyterms: () => ['AcmeBioLab', 'dana'] })
    const session = await sessions.create(ALICE, { calendarEventId: 'fake-acme-sync', tz: 'UTC' })
    await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    expect(started[0]?.vocabulary).toEqual(['Alice', 'Dana Lee', 'Dana', 'Lee', 'AcmeBioLab'])

    // A restart recovers the session from disk with the same words.
    await sessions.close()
    sessions = openSessions(null, { transcriber })
    await sessions.recover()
    await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    expect(started[1]?.vocabulary).toEqual(started[0]?.vocabulary)
  })

  it('sends none when there are no words', async () => {
    const started: Array<Parameters<Transcriber['start']>[0]> = []
    const fake = new FakeTranscriber()
    await sessions.close()
    sessions = openSessions(null, {
      transcriber: {
        start: (opts) => {
          started.push(opts)
          return fake.start(opts)
        },
      },
      keyterms: () => [],
    })
    const session = await sessions.create({ ...ALICE, name: 'A' }, { tz: 'UTC' })
    await sessions.attachAudio(session.id, { send: () => {}, close: () => {} })
    expect(started[0]).not.toHaveProperty('vocabulary')
  })

  it('caps the list at 100 and drops repeats ignoring case', () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`)
    const out = meetingVocabulary(['Dana Lee', 'dana lee', undefined], ['DANA', ...words])
    expect(out.slice(0, 3)).toEqual(['Dana Lee', 'Dana', 'Lee'])
    expect(out).toHaveLength(100)
    expect(out.filter((w) => w.toLowerCase() === 'dana')).toHaveLength(1)
  })
})
