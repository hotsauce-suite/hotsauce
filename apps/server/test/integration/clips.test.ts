import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { FakeClipTranscriber, probe } from '../../src/clips/index.js'
import { type Config, loadConfig } from '../../src/config.js'
import { HearthError } from '../../src/errors.js'
import { FakeLLM, LocalAudioStore } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const run = promisify(execFile)
const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const FFMPEG = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

let fixtures: string
let webm: Buffer
let mp4: Buffer
let silentWebm: Buffer

/** What Chrome's MediaRecorder makes, near enough: a live-style WebM and a fragmented MP4. */
beforeAll(async () => {
  fixtures = await makeTempDir('hearth-clip-fixtures-')
  const src = [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=15:duration=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=5',
  ]
  await run('ffmpeg', [
    '-y',
    ...src,
    '-c:v',
    'libvpx',
    '-b:v',
    '300k',
    '-c:a',
    'libopus',
    // Like MediaRecorder: no cues, no duration in the header.
    '-live',
    '1',
    '-f',
    'webm',
    join(fixtures, 'rec.webm'),
  ])
  await run('ffmpeg', [
    '-y',
    ...src,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    join(fixtures, 'rec.mp4'),
  ])
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=15:duration=3',
    '-c:v',
    'libvpx',
    '-an',
    '-live',
    '1',
    '-f',
    'webm',
    join(fixtures, 'silent.webm'),
  ])
  webm = await readFile(join(fixtures, 'rec.webm'))
  mp4 = await readFile(join(fixtures, 'rec.mp4'))
  silentWebm = await readFile(join(fixtures, 'silent.webm'))
}, 60_000)

afterAll(async () => {
  await removeDir(fixtures)
})

let root: string
let config: Config
let services: Services
let app: ReturnType<typeof createApp>
let asr: FakeClipTranscriber
let llm: FakeLLM

beforeEach(async () => {
  root = await makeTempDir('hearth-clips-')
  config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    AUDIO_STORE: 'local',
  })
  asr = new FakeClipTranscriber()
  llm = new FakeLLM()
  services = createServices(config, { llm, clipTranscriber: asr })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.clips.idle()
  services.clips.close()
  services.clips.store.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

interface Options {
  as?: string
  json?: unknown
  body?: Uint8Array | undefined
  headers?: Record<string, string>
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
  return app.request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: body as BodyInit } : {}),
  })
}

async function json<T = Record<string, unknown>>(res: Response, status = 200): Promise<T> {
  const text = await res.text()
  expect(res.status, text).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

interface Clip {
  id: string
  title: string
  summary: string | null
  status: string
  durationMs: number | null
  mimeType: string
  isOwner: boolean
  transcriptStatus: string
  videoUrl: string | null
  thumbUrl: string | null
  downloadUrl: string | null
}

/** Splits `bytes` into `n` contiguous slices, like MediaRecorder's timeslice. */
function slices(bytes: Uint8Array, n: number): Uint8Array[] {
  const size = Math.ceil(bytes.length / n)
  return Array.from({ length: n }, (_, i) => bytes.subarray(i * size, (i + 1) * size))
}

async function record(
  as: string,
  bytes: Uint8Array,
  container: 'webm' | 'mp4' = 'webm',
  order?: number[],
): Promise<Clip> {
  const clip = await json<Clip>(
    await call('POST', '/api/clips', {
      as,
      json: { mode: 'screen_camera', container, title: 'Recording' },
    }),
    201,
  )
  const parts = slices(bytes, 4)
  for (const seq of order ?? parts.map((_, i) => i)) {
    const res = await call('PUT', `/api/clips/${clip.id}/chunks/${seq}`, {
      as,
      body: parts[seq] as Uint8Array,
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(res.status).toBe(204)
  }
  const done = await json<Clip>(
    await call('POST', `/api/clips/${clip.id}/finish`, { as, json: { chunks: parts.length } }),
  )
  expect(done.status).toBe('processing')
  await services.clips.idle()
  return done
}

async function get(as: string, id: string) {
  return json<{ clip: Clip; transcript: Array<{ start: number; end: number; text: string }> }>(
    await call('GET', `/api/clips/${id}`, { as }),
  )
}

describe('recording a clip', () => {
  it('assembles chunks into a seekable WebM with a thumbnail, transcript, title and summary', async () => {
    const { id } = await record(ALICE, webm)
    const { clip, transcript } = await get(ALICE, id)
    expect(clip.status).toBe('ready')
    expect(clip.mimeType).toBe('video/webm')
    expect(clip.durationMs).toBeGreaterThan(4500)
    expect(clip.durationMs).toBeLessThan(5500)
    expect(clip.isOwner).toBe(true)
    expect(clip.thumbUrl).toMatch(/^\/api\/clips\/media\//)
    // FakeClipTranscriber: one line per 2 s.
    expect(transcript.map((s) => s.text)).toEqual([
      'clip segment 1',
      'clip segment 2',
      'clip segment 3',
    ])
    expect(transcript[1]?.start).toBe(2)
    expect(clip.transcriptStatus).toBe('ready')
    // The suggested title replaces the default one; FakeLLM names it after the first line.
    expect(clip.title).toBe('About clip segment 1')
    expect(clip.summary).toContain('clip segment 1')
    // Acme's words reach Deepgram as keyterms.
    expect(asr.calls[0]?.keyterms).toContain('Hotsauce')
    expect(asr.calls[0]?.mimeType).toBe('audio/flac')

    // The stored video has a duration in its header (what MediaRecorder leaves out) and cues.
    const store = new LocalAudioStore(config.DATA_DIR)
    const file = store.pathOf(`clips/${id}/video.webm`)
    const info = await probe(FFMPEG, file)
    expect(info.durationMs).toBeGreaterThan(4500)
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ])
    expect(Number(stdout)).toBeGreaterThan(4.5)
    // Uploads and the work folder are cleaned up.
    expect(existsSync(join(config.DATA_DIR, 'clips', 'uploads', id))).toBe(false)
    expect(existsSync(join(config.DATA_DIR, 'clips', 'work', id))).toBe(false)
  })

  it('makes a fragmented MP4 into a faststart MP4', async () => {
    const { id } = await record(ALICE, mp4, 'mp4')
    const { clip } = await get(ALICE, id)
    expect(clip.status).toBe('ready')
    expect(clip.mimeType).toBe('video/mp4')
    expect(clip.durationMs).toBeGreaterThan(4500)
    const bytes = await readFile(
      new LocalAudioStore(config.DATA_DIR).pathOf(`clips/${id}/video.mp4`),
    )
    // faststart: the moov box comes before the media data.
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))
    expect(bytes.indexOf('moof')).toBe(-1)
  })

  it('takes chunks out of order and again (retries) and still assembles them in order', async () => {
    const { id } = await record(ALICE, webm, 'webm', [2, 0, 3, 1, 2, 0])
    expect((await get(ALICE, id)).clip.status).toBe('ready')
  })

  it('refuses to finish while chunks are missing, then finishes when they arrive', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', { as: ALICE, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
    const parts = slices(webm, 3)
    for (const seq of [0, 2]) {
      await call('PUT', `/api/clips/${clip.id}/chunks/${seq}`, { as: ALICE, body: parts[seq] })
    }
    const refused = await json<{ error: { code: string; message: string } }>(
      await call('POST', `/api/clips/${clip.id}/finish`, { as: ALICE, json: { chunks: 3 } }),
      409,
    )
    expect(refused.error.message).toBe('Chunks 1 haven’t arrived')
    await call('PUT', `/api/clips/${clip.id}/chunks/1`, { as: ALICE, body: parts[1] })
    await json(
      await call('POST', `/api/clips/${clip.id}/finish`, { as: ALICE, json: { chunks: 3 } }),
    )
    // Finishing twice is harmless.
    const again = await json<Clip>(
      await call('POST', `/api/clips/${clip.id}/finish`, { as: ALICE, json: { chunks: 3 } }),
    )
    expect(['processing', 'ready']).toContain(again.status)
    await services.clips.idle()
    expect((await get(ALICE, clip.id)).clip.status).toBe('ready')
    // No chunks once finished.
    await json(
      await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as: ALICE, body: parts[0] }),
      409,
    )
  })

  it('marks a clip without sound as having no transcript, and a broken recording as failed', async () => {
    const silent = await record(ALICE, silentWebm)
    const quiet = await get(ALICE, silent.id)
    expect(quiet.clip.status).toBe('ready')
    expect(quiet.clip.transcriptStatus).toBe('none')
    expect(asr.calls).toHaveLength(0)

    const broken = await record(ALICE, new TextEncoder().encode('not a video at all'.repeat(10)))
    const failed = await get(ALICE, broken.id)
    expect(failed.clip.status).toBe('failed')
    expect(failed.clip.videoUrl).toBeNull()
  })

  it('keeps the title the owner chose over the suggested one', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', { as: ALICE, json: { mode: 'camera', container: 'webm' } }),
      201,
    )
    await json(await call('PATCH', `/api/clips/${clip.id}`, { as: ALICE, json: { title: 'Mine' } }))
    for (const [seq, part] of slices(webm, 2).entries()) {
      await call('PUT', `/api/clips/${clip.id}/chunks/${seq}`, { as: ALICE, body: part })
    }
    await json(
      await call('POST', `/api/clips/${clip.id}/finish`, { as: ALICE, json: { chunks: 2 } }),
    )
    await services.clips.idle()
    const { clip: done } = await get(ALICE, clip.id)
    expect(done.title).toBe('Mine')
    expect(done.summary).toContain('clip segment 1')
  })
})

describe('transcripts', () => {
  it('records a failed transcript and transcribes again on retry, from the stored video', async () => {
    const failing = {
      calls: 0,
      async transcribe() {
        this.calls++
        throw new HearthError('asr_error', 'The transcription service refused this audio')
      },
    }
    const real = asr
    // Swap the transcriber by rebuilding the services around a failing one.
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, { llm, clipTranscriber: failing })
    app = createApp(services)
    const { id } = await record(ALICE, webm)
    let { clip } = await get(ALICE, id)
    expect(clip.status).toBe('ready')
    expect(clip.transcriptStatus).toBe('failed')
    expect(clip.title).toBe('Recording')

    // Only the owner can retry.
    await json(await call('POST', `/api/clips/${id}/transcript/retry`, { as: BOB }), 403)

    // Back to a working transcriber; the retry downloads the video again from the store.
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, { llm, clipTranscriber: real })
    app = createApp(services)
    const retried = await json<Clip>(
      await call('POST', `/api/clips/${id}/transcript/retry`, { as: ALICE }),
    )
    expect(retried.transcriptStatus).toBe('pending')
    await services.clips.idle()
    ;({ clip } = await get(ALICE, id))
    expect(clip.transcriptStatus).toBe('ready')
    expect(failing.calls).toBe(1)
  })
})

describe('who can do what', () => {
  it('lets any member watch and list, and only the owner change, delete or upload', async () => {
    const { id } = await record(ALICE, webm)
    const seen = await get(BOB, id)
    expect(seen.clip.isOwner).toBe(false)
    expect(seen.clip.videoUrl).not.toBeNull()

    await json(await call('PATCH', `/api/clips/${id}`, { as: BOB, json: { title: 'x' } }), 403)
    await json(await call('DELETE', `/api/clips/${id}`, { as: BOB }), 403)
    await json(await call('POST', `/api/clips/${id}/finish`, { as: BOB, json: { chunks: 1 } }), 403)

    const bobs = await json<Clip>(
      await call('POST', '/api/clips', { as: BOB, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
    await json(await call('PUT', `/api/clips/${bobs.id}/chunks/0`, { as: ALICE, body: webm }), 403)
    // A recording in progress is the owner's alone.
    await json(await call('GET', `/api/clips/${bobs.id}`, { as: ALICE }), 404)
    expect((await get(BOB, bobs.id)).clip.status).toBe('recording')

    const renamed = await json<Clip>(
      await call('PATCH', `/api/clips/${id}`, {
        as: ALICE,
        json: { title: '  Demo of the thing ' },
      }),
    )
    expect(renamed.title).toBe('Demo of the thing')
    await json(await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { title: '   ' } }), 400)
  })

  it('refuses requests without a session (401) and from outside the domain', async () => {
    const { id } = await record(ALICE, webm)
    for (const [method, url] of [
      ['GET', '/api/clips'],
      ['GET', `/api/clips/${id}`],
      ['POST', '/api/clips'],
      ['DELETE', `/api/clips/${id}`],
      ['PUT', `/api/clips/${id}/chunks/0`],
    ] as const) {
      expect((await call(method, url)).status, `${method} ${url}`).toBe(401)
    }
    const outsider = await call('GET', `/api/clips/${id}`, { as: 'eve@example.com' })
    expect(outsider.status).toBe(403)
  })

  it('lists mine and the team’s, newest first, and searches titles and transcripts', async () => {
    const a = await record(ALICE, webm)
    await json(
      await call('PATCH', `/api/clips/${a.id}`, {
        as: ALICE,
        json: { title: 'Pricing walkthrough' },
      }),
    )
    const b = await record(BOB, webm)
    await json(
      await call('PATCH', `/api/clips/${b.id}`, { as: BOB, json: { title: 'Bug in 50%_off' } }),
    )
    // A recording nobody finished isn't listed anywhere.
    await call('POST', '/api/clips', { as: BOB, json: { mode: 'screen', container: 'webm' } })

    const list = async (as: string, query: string) =>
      (await json<{ clips: Clip[] }>(await call('GET', `/api/clips?${query}`, { as }))).clips.map(
        (c) => c.title,
      )
    expect(await list(ALICE, 'scope=mine')).toEqual(['Pricing walkthrough'])
    expect(await list(ALICE, 'scope=team')).toEqual(['Bug in 50%_off', 'Pricing walkthrough'])
    expect(await list(ALICE, 'scope=team&q=pricing')).toEqual(['Pricing walkthrough'])
    // LIKE wildcards in a search match themselves.
    expect(await list(ALICE, 'scope=team&q=%25_')).toEqual(['Bug in 50%_off'])
    // The transcript is searched too.
    expect(await list(BOB, 'scope=team&q=segment%203')).toHaveLength(2)
    expect(await list(BOB, 'scope=team&q=nothing-like-this')).toEqual([])
  })
})

describe('playback', () => {
  it('serves the video by signed URL with byte ranges, and refuses a tampered or unsigned one', async () => {
    const { id } = await record(ALICE, webm)
    const { clip } = await get(BOB, id)
    const url = clip.videoUrl as string

    // No session needed: the URL is the credential.
    const whole = await call('GET', url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/webm')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    const size = Number(whole.headers.get('content-length'))
    expect((await whole.arrayBuffer()).byteLength).toBe(size)

    const part = await call('GET', url, { headers: { range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${size}`)
    expect((await part.arrayBuffer()).byteLength).toBe(100)

    const tail = await call('GET', url, { headers: { range: 'bytes=-10' } })
    expect(tail.status).toBe(206)
    expect((await tail.arrayBuffer()).byteLength).toBe(10)

    expect((await call('GET', url, { headers: { range: `bytes=${size}-` } })).status).toBe(416)

    const thumb = await call('GET', clip.thumbUrl as string)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    const jpeg = new Uint8Array(await thumb.arrayBuffer())
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8])

    const download = await call('GET', clip.downloadUrl as string)
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="/)

    // Another clip's file with this signature, a changed expiry, or no signature: 404.
    const tampered = url.replace(/exp=(\d+)/, (_, n) => `exp=${Number(n) + 1}`)
    expect((await call('GET', tampered)).status).toBe(404)
    expect((await call('GET', url.replace('/video?', '/thumb?'))).status).toBe(404)
    expect((await call('GET', url.split('?')[0] as string)).status).toBe(404)
  })
})

describe('deleting and cancelling', () => {
  it('removes the stored video, thumbnail and row', async () => {
    const { id } = await record(ALICE, webm)
    const store = new LocalAudioStore(config.DATA_DIR)
    expect(existsSync(store.pathOf(`clips/${id}/video.webm`))).toBe(true)
    await json(await call('DELETE', `/api/clips/${id}`, { as: ALICE }), 204)
    expect(existsSync(store.pathOf(`clips/${id}/video.webm`))).toBe(false)
    expect(existsSync(store.pathOf(`clips/${id}/thumb.jpg`))).toBe(false)
    await json(await call('GET', `/api/clips/${id}`, { as: ALICE }), 404)
  })

  it('cancelling a recording removes its chunks', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', { as: ALICE, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
    await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as: ALICE, body: webm })
    const uploads = join(config.DATA_DIR, 'clips', 'uploads', clip.id)
    expect(await readdir(uploads)).toHaveLength(1)
    await json(await call('DELETE', `/api/clips/${clip.id}`, { as: ALICE }), 204)
    expect(existsSync(uploads)).toBe(false)
  })

  it('caps open recordings per member at three', async () => {
    for (let i = 0; i < 3; i++) {
      await json(
        await call('POST', '/api/clips', {
          as: ALICE,
          json: { mode: 'screen', container: 'webm' },
        }),
        201,
      )
    }
    const refused = await call('POST', '/api/clips', {
      as: ALICE,
      json: { mode: 'screen', container: 'webm' },
    })
    expect(refused.status).toBe(409)
    // Another member isn't affected.
    await json(
      await call('POST', '/api/clips', { as: BOB, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
  })

  it('the sweep removes upload folders with no clip, and a failed clip leaves none', async () => {
    const orphan = join(config.DATA_DIR, 'clips', 'uploads', '01ORPHANORPHANORPHANORPHAN')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, '000000.part'), 'x')
    await services.clips.sweep()
    expect(existsSync(orphan)).toBe(false)

    const broken = await record(ALICE, new TextEncoder().encode('not a video at all'.repeat(10)))
    expect(existsSync(join(config.DATA_DIR, 'clips', 'uploads', broken.id))).toBe(false)
  })

  it('a restart picks up a clip that was being processed', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', { as: ALICE, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
    await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as: ALICE, body: webm })
    // As if the server died just after Stop: processing, chunks on disk, no job running.
    services.clips.store.update(clip.id, { status: 'processing' }, new Date().toISOString())
    expect(services.clips.recover()).toBe(1)
    await services.clips.idle()
    expect((await get(ALICE, clip.id)).clip.status).toBe('ready')
  })
})
