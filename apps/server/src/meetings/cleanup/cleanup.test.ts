import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HearthError } from '../../errors.js'
import { FakeLLM } from '../llm/fake.js'
import type { TranscriptSegment } from '../transcriber/types.js'
import { type CleanupJob, TranscriptCleanup } from './cleanup.js'
import { FakeRetranscriber, type MeetingRetranscriber } from './retranscriber.js'

const PATH = 'meetings/2026/11/2026-11-12-sync.transcript.md'
const LIVE = [
  '# Sync: transcript',
  '',
  '[00:00:00] **Me:** we met pria at acme bio lab',
  '[00:00:02] **Them:** great to meet you all today',
  '',
].join('\n')

/** Just enough of GitStore: one file, a blob id per content, `unchanged` refused when stale. */
class OneFileGit {
  content: string | null = LIVE
  version = 1
  commits: Array<{ content: string; message: string }> = []
  async readFile(_space: string, _path: string) {
    if (this.content === null) throw new HearthError('not_found', 'gone')
    return { content: this.content, blobOid: String(this.version).padStart(40, '0') }
  }
  async commit(
    _space: string,
    args: {
      changes: Array<{ path: string; content: string }>
      message: string
      unchanged?: { blobOid: string }
    },
  ) {
    if (args.unchanged && args.unchanged.blobOid !== String(this.version).padStart(40, '0')) {
      throw new HearthError('conflict', 'changed')
    }
    this.content = args.changes[0]?.content ?? ''
    this.version++
    this.commits.push({ content: this.content, message: args.message })
    return { status: 'committed' as const, oid: 'x', blobOid: 'y' }
  }
}

let dir: string
let git: OneFileGit
let logs: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hearth-cleanup-'))
  await writeFile(join(dir, 'me.pcm'), new Uint8Array(64_000))
  await writeFile(join(dir, 'them.pcm'), new Uint8Array(64_000))
  git = new OneFileGit()
  logs = []
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function cleanup(opts: { retranscriber?: MeetingRetranscriber | null; llm?: FakeLLM | null }) {
  return new TranscriptCleanup({
    git: git as never,
    afterCommit: async () => {},
    retranscriber: opts.retranscriber ?? null,
    llm: opts.llm ?? null,
    model: 'claude-haiku-5-5',
    log: (m) => logs.push(m),
  })
}

function job(withAudio: boolean): CleanupJob {
  return {
    id: 'm1',
    space: 'alice',
    title: 'Sync',
    transcriptPath: PATH,
    author: { name: 'Alice', email: 'alice@example.test' },
    vocabulary: ['Priya Shah', 'Priya', 'AcmeBioLab'],
    ...(withAudio
      ? {
          audio: {
            me: { file: join(dir, 'me.pcm'), bytes: 64_000 },
            them: { file: join(dir, 'them.pcm'), bytes: 64_000 },
          },
        }
      : {}),
  }
}

const fixes = new FakeLLM(() =>
  JSON.stringify([
    { line: 0, from: 'pria', to: 'Priya' },
    { line: 0, from: 'acme bio lab', to: 'AcmeBioLab' },
  ]),
)

describe('TranscriptCleanup', () => {
  it('re-transcribes kept audio and commits it as the owner', async () => {
    const c = cleanup({ retranscriber: new FakeRetranscriber({ speakers: 2 }), llm: fixes })
    expect(await c.start(job(true))).toBe('retranscribed')
    expect(git.commits).toHaveLength(1)
    expect(git.commits[0]?.message).toBe('meetings: clean up transcript of "Sync"')
    expect(git.content).toContain('[00:00:01] **Speaker 2:** their tidy sentence 2')
    expect(git.content).toContain('[00:00:00] **Me:** my clean words 1')
  })

  it('falls back to the spelling pass without kept audio, or when re-transcribing fails', async () => {
    expect(await cleanup({ llm: fixes }).start(job(false))).toBe('spelling')
    expect(git.content).toContain('**Me:** we met Priya at AcmeBioLab')
    expect(git.content).toContain('**Them:** great to meet you all today')

    git = new OneFileGit()
    const failing = new FakeRetranscriber({ fail: true })
    expect(await cleanup({ retranscriber: failing, llm: fixes }).start(job(true))).toBe('spelling')
    expect(logs.join('\n')).toMatch(/re-transcribing kept audio failed/)
  })

  it('keeps the live transcript when the re-transcription hears much less', async () => {
    const quiet: MeetingRetranscriber = {
      async transcribe(input) {
        const seg: TranscriptSegment = {
          track: input.track,
          speaker: 'Me',
          at: 0,
          durationMs: 1,
          text: 'hm',
          final: true,
        }
        return input.track === 'me' ? [seg] : []
      },
    }
    expect(await cleanup({ retranscriber: quiet }).start(job(true))).toBe('unchanged')
    expect(git.commits).toHaveLength(0)
  })

  it('drops its result when the transcript changed since the save', async () => {
    const llm = new FakeLLM(async () => {
      // The member renames a speaker while Claude is still reading.
      git.content = LIVE.replace('**Them:**', '**Dana Lee:**')
      git.version++
      return JSON.stringify([{ line: 0, from: 'pria', to: 'Priya' }])
    })
    expect(await cleanup({ llm }).start(job(false))).toBe('skipped')
    expect(git.content).toContain('**Dana Lee:**')
    expect(git.content).toContain('pria')
  })

  it('does nothing without a word list, and never throws', async () => {
    const c = cleanup({ llm: fixes })
    expect(await c.start({ ...job(false), vocabulary: [] })).toBe('unchanged')
    git.content = null
    expect(await c.start(job(false))).toBe('skipped')
    expect(git.commits).toHaveLength(0)
  })

  it('settled waits for the cleanup, and past its limit stops it so nothing is committed', async () => {
    let release: () => void = () => {}
    const slow: MeetingRetranscriber = {
      transcribe: (input) =>
        new Promise((resolve, reject) => {
          release = () => resolve([])
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const c = cleanup({ retranscriber: slow, llm: fixes })
    const done = c.start(job(true))
    expect(c.running('m1')).toBe(true)
    await c.settled('m1', 20)
    expect(await done).toBe('skipped')
    expect(c.running('m1')).toBe(false)
    expect(git.commits).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/took too long/)
    release()

    // A cleanup that finishes in time is simply awaited.
    const quick = cleanup({ llm: fixes })
    const pending = quick.start(job(false))
    await quick.settled('m1', 5_000)
    expect(await pending).toBe('spelling')
    await quick.settled('nothing-running')
  })

  it('once committing, settled waits for the commit instead of stopping it', async () => {
    let finish: () => void = () => {}
    const slowGit = new OneFileGit()
    const commit = slowGit.commit.bind(slowGit)
    slowGit.commit = (async (space: string, args: Parameters<OneFileGit['commit']>[1]) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return commit(space, args)
    }) as OneFileGit['commit']
    git = slowGit
    const c = cleanup({ llm: fixes })
    const done = c.start(job(false))
    await new Promise((r) => setTimeout(r, 20))
    const waiting = c.settled('m1', 10)
    setTimeout(() => finish(), 50)
    await waiting
    // settled returned only after the commit landed.
    expect(slowGit.commits).toHaveLength(1)
    expect(await done).toBe('spelling')
  })

  it('abort stops a deleted meeting’s cleanup before it commits', async () => {
    const llm = new FakeLLM(async () => {
      await new Promise((r) => setTimeout(r, 30))
      return JSON.stringify([{ line: 0, from: 'pria', to: 'Priya' }])
    })
    const c = cleanup({ llm })
    const done = c.start(job(false))
    c.abort('m1')
    expect(await done).toBe('skipped')
    expect(git.commits).toHaveLength(0)
  })

  it('keeps the live transcript when one side comes back nearly empty', async () => {
    const oneSided: MeetingRetranscriber = {
      async transcribe(input) {
        return input.track === 'me'
          ? [
              {
                track: 'me',
                speaker: 'Me',
                at: 0,
                durationMs: 1,
                text: 'we met Priya at AcmeBioLab and lots more words here',
                final: true,
              },
            ]
          : []
      },
    }
    expect(await cleanup({ retranscriber: oneSided }).start(job(true))).toBe('unchanged')
    expect(logs.join('\n')).toMatch(/heard much less on them/)
  })
})
