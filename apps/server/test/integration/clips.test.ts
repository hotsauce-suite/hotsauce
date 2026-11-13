import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { bubbleGeometry, FakeClipTranscriber, probe } from '../../src/clips/index.js'
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
/** A plain blue camera, so its pixels are easy to find in the composite. */
let cameraWebm: Buffer

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
  await run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x0000ff:size=320x240:rate=15:duration=4',
    '-c:v',
    'libvpx',
    '-b:v',
    '200k',
    '-live',
    '1',
    '-f',
    'webm',
    join(fixtures, 'camera.webm'),
  ])
  cameraWebm = await readFile(join(fixtures, 'camera.webm'))
}, 60_000)

/** The RGB colour of one pixel of `file` at `seconds`. */
async function pixel(file: string, seconds: number, x: number, y: number): Promise<number[]> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=2:2:${x - (x % 2)}:${y - (y % 2)}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  )
  return [...(stdout as Buffer).subarray(0, 3)]
}

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
  compositeStatus: string
  speakers: Array<{ id: number; name: string; named: boolean }>
  aiSummary: string | null
  aiActions: string | null
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
  return json<{
    clip: Clip
    transcript: Array<{ start: number; end: number; text: string; speaker?: number }>
  }>(await call('GET', `/api/clips/${id}`, { as }))
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

describe('a nearly full disk', () => {
  it('stops new recordings and new chunks, so git and SQLite keep room', async () => {
    let free = 50 * 1024 ** 3
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, {
      llm,
      clipTranscriber: asr,
      diskFreeBytes: async () => free,
    })
    app = createApp(services)

    const clip = await json<Clip>(
      await call('POST', '/api/clips', {
        as: ALICE,
        json: { mode: 'screen_camera', container: 'webm', title: 'Recording' },
      }),
      201,
    )
    free = 200 * 1024 ** 2
    const chunk = await call('PUT', `/api/clips/${clip.id}/chunks/0`, {
      as: ALICE,
      body: webm.subarray(0, 1000),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(chunk.status).toBe(409)
    expect(((await chunk.json()) as { error: { message: string } }).error.message).toMatch(
      /disk is nearly full/,
    )
    const another = await call('POST', '/api/clips', {
      as: ALICE,
      json: { mode: 'screen_camera', container: 'webm', title: 'Another' },
    })
    expect(another.status).toBe(409)
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

describe('the camera bubble', () => {
  async function recordWithCamera(cameraOffsetMs = 0) {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', {
        as: ALICE,
        json: { mode: 'screen_camera', container: 'webm' },
      }),
      201,
    )
    const screen = slices(webm, 3)
    const camera = slices(cameraWebm, 2)
    for (const [seq, part] of screen.entries()) {
      await json(
        await call('PUT', `/api/clips/${clip.id}/chunks/${seq}`, { as: ALICE, body: part }),
        204,
      )
    }
    for (const [seq, part] of camera.entries()) {
      await json(
        await call('PUT', `/api/clips/${clip.id}/chunks/${seq}?track=camera`, {
          as: ALICE,
          body: part,
        }),
        204,
      )
    }
    const finished = await json<Clip>(
      await call('POST', `/api/clips/${clip.id}/finish`, {
        as: ALICE,
        json: {
          chunks: 3,
          camera: { chunks: 2, container: 'webm', offsetMs: cameraOffsetMs },
          screenSurface: 'window',
          screenLabel: 'Pricing – Google Chrome',
        },
      }),
    )
    expect(finished.compositeStatus).toBe('pending')
    await services.clips.idle()
    return clip.id
  }

  it('records the camera separately and puts it into the video as a round bubble', async () => {
    const id = await recordWithCamera(500)
    const { clip } = await get(ALICE, id)
    expect(clip.compositeStatus).toBe('ready')
    expect(clip.mimeType).toBe('video/mp4')
    expect(clip.videoUrl).toContain('/composite?')
    expect(clip).toMatchObject({ screenSurface: 'window', screenLabel: 'Pricing – Google Chrome' })

    const store = new LocalAudioStore(config.DATA_DIR)
    const composite = store.pathOf(`clips/${id}/composite.mp4`)
    const screen = store.pathOf(`clips/${id}/video.webm`)
    expect(existsSync(store.pathOf(`clips/${id}/camera.webm`))).toBe(true)
    // The page's length is the length of the video it now plays.
    expect(clip.durationMs).toBe((await probe(FFMPEG, composite)).durationMs)
    // 320×240 screen: the bubble is 58 px across, 8 px in from the bottom left (bubbleGeometry).
    const { size, margin } = bubbleGeometry(240)
    const [cx, cy] = [margin + size / 2, 240 - margin - size / 2]
    const inBubble = await pixel(composite, 2, cx, cy)
    const sameSpotOnScreen = await pixel(screen, 2, cx, cy)
    // Blue camera in the bubble; the screen there is something else.
    expect(inBubble[2]).toBeGreaterThan(180)
    expect(inBubble[0]).toBeLessThan(80)
    expect(inBubble).not.toEqual(sameSpotOnScreen)
    // Before the camera starts (0.5 s late) the corner is the screen's.
    const early = await pixel(composite, 0.1, cx, cy)
    expect(early[2]).toBeLessThan(180)
    // Outside the bubble the screen is untouched.
    const corner = await pixel(composite, 2, 300, 20)
    const screenCorner = await pixel(screen, 2, 300, 20)
    for (const [i, v] of corner.entries()) {
      expect(Math.abs(v - (screenCorner[i] ?? 0))).toBeLessThan(40)
    }
    // The camera's chunks are cleaned up once it's in.
    expect(existsSync(join(config.DATA_DIR, 'clips', 'uploads', id))).toBe(false)

    // Deleting removes the composite and the camera too.
    await json(await call('DELETE', `/api/clips/${id}`, { as: ALICE }), 204)
    expect(existsSync(composite)).toBe(false)
    expect(existsSync(store.pathOf(`clips/${id}/camera.webm`))).toBe(false)
  })

  it('keeps the screen video when the camera can’t be put in', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', {
        as: ALICE,
        json: { mode: 'screen_camera', container: 'webm' },
      }),
      201,
    )
    await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as: ALICE, body: webm })
    await call('PUT', `/api/clips/${clip.id}/chunks/0?track=camera`, {
      as: ALICE,
      body: new TextEncoder().encode('not a camera'.repeat(20)),
    })
    await json(
      await call('POST', `/api/clips/${clip.id}/finish`, {
        as: ALICE,
        json: { chunks: 1, camera: { chunks: 1, container: 'webm', offsetMs: 0 } },
      }),
    )
    await services.clips.idle()
    const { clip: done } = await get(ALICE, clip.id)
    expect(done.status).toBe('ready')
    expect(done.compositeStatus).toBe('failed')
    expect(done.mimeType).toBe('video/webm')
    expect(done.videoUrl).toContain('/video?')
  })

  it('refuses to finish while camera chunks are missing', async () => {
    const clip = await json<Clip>(
      await call('POST', '/api/clips', {
        as: ALICE,
        json: { mode: 'screen_camera', container: 'webm' },
      }),
      201,
    )
    await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as: ALICE, body: webm })
    const res = await json<{ error: { message: string } }>(
      await call('POST', `/api/clips/${clip.id}/finish`, {
        as: ALICE,
        json: { chunks: 1, camera: { chunks: 2, container: 'webm', offsetMs: 0 } },
      }),
      409,
    )
    expect(res.error.message).toBe('Camera chunks 0, 1 haven’t arrived')
  })

  it('makes one camera bubble at a time, in order', async () => {
    // An ffmpeg that notes when a composite (the only call with -filter_complex) starts and ends.
    const { writeFile, readFile: read, chmod } = await import('node:fs/promises')
    const wrapper = join(root, 'ffmpeg-wrapper.sh')
    const log = join(root, 'composites.log')
    await writeFile(
      wrapper,
      `#!/bin/sh
case "$*" in
  *filter_complex*)
    [ -e "${root}/busy" ] && echo overlap >> "${log}"
    touch "${root}/busy"; echo start >> "${log}"
    ffmpeg "$@"; code=$?
    rm -f "${root}/busy"; echo end >> "${log}"; exit $code;;
esac
exec ffmpeg "$@"
`,
    )
    await chmod(wrapper, 0o755)
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      AUDIO_STORE: 'local',
      FFMPEG_PATH: wrapper,
    })
    services = createServices(config, { llm, clipTranscriber: asr })
    app = createApp(services)
    // Three clips finished back to back, without waiting between them.
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const clip = await json<Clip>(
        await call('POST', '/api/clips', {
          as: i === 1 ? BOB : ALICE,
          json: { mode: 'screen_camera', container: 'webm' },
        }),
        201,
      )
      const as = i === 1 ? BOB : ALICE
      await call('PUT', `/api/clips/${clip.id}/chunks/0`, { as, body: webm })
      await call('PUT', `/api/clips/${clip.id}/chunks/0?track=camera`, { as, body: cameraWebm })
      await json(
        await call('POST', `/api/clips/${clip.id}/finish`, {
          as,
          json: { chunks: 1, camera: { chunks: 1, container: 'webm', offsetMs: 0 } },
        }),
      )
      ids.push(clip.id)
    }
    await services.clips.idle()
    for (const id of ids) expect((await get(ALICE, id)).clip.compositeStatus).toBe('ready')
    expect((await read(log, 'utf8')).trim().split('\n')).toEqual([
      'start',
      'end',
      'start',
      'end',
      'start',
      'end',
    ])
  })

  it('a camera bubble still waiting in the queue at a restart is made after it', async () => {
    const id = await recordWithCamera()
    const store = new LocalAudioStore(config.DATA_DIR)
    const { rm: remove } = await import('node:fs/promises')
    await remove(store.pathOf(`clips/${id}/composite.mp4`))
    // Queued, never started: the server stopped before its turn came.
    services.clips.store.update(id, { compositeStatus: 'pending' }, new Date().toISOString())
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, { llm, clipTranscriber: asr })
    app = createApp(services)
    expect(services.clips.recover()).toBeGreaterThanOrEqual(1)
    await services.clips.idle()
    expect((await get(ALICE, id)).clip.compositeStatus).toBe('ready')
    expect(existsSync(store.pathOf(`clips/${id}/composite.mp4`))).toBe(true)
  })

  it('a restart picks up a camera bubble that was being made', async () => {
    const id = await recordWithCamera()
    // As if it died part way: back to processing, its output gone (the kept camera file stays).
    const store = new LocalAudioStore(config.DATA_DIR)
    const { rm: remove } = await import('node:fs/promises')
    await remove(store.pathOf(`clips/${id}/composite.mp4`))
    services.clips.store.update(id, { compositeStatus: 'processing' }, new Date().toISOString())
    expect(services.clips.recover()).toBeGreaterThanOrEqual(1)
    await services.clips.idle()
    expect((await get(ALICE, id)).clip.compositeStatus).toBe('ready')
    expect(existsSync(store.pathOf(`clips/${id}/composite.mp4`))).toBe(true)
  })
})

describe('speakers, summaries, action items and notes', () => {
  it('names speakers: two found, defaults, owner renames, others can’t', async () => {
    const { id } = await record(ALICE, webm)
    let { clip, transcript } = await get(ALICE, id)
    expect(transcript.map((s) => s.speaker)).toEqual([0, 1, 0])
    expect(clip.speakers).toEqual([
      { id: 0, name: 'Speaker 1', named: false },
      { id: 1, name: 'Speaker 2', named: false },
    ])
    await json(
      await call('PATCH', `/api/clips/${id}`, { as: BOB, json: { speakers: { '0': 'x' } } }),
      403,
    )
    await json(
      await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { speakers: { '7': 'x' } } }),
      400,
    )
    const renamed = await json<Clip>(
      await call('PATCH', `/api/clips/${id}`, {
        as: ALICE,
        json: { speakers: { '1': '  Bob  B. ' } },
      }),
    )
    expect(renamed.speakers[1]).toEqual({ id: 1, name: 'Bob B.', named: true })
    // The prompts see the names.
    await json(await call('POST', `/api/clips/${id}/ai`, { as: ALICE, json: { kind: 'summary' } }))
    expect(llm.calls.at(-1)?.messages[0]?.content).toContain('[0:02] Bob B.: clip segment 2')
    // An empty name goes back to the default.
    const reset = await json<Clip>(
      await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { speakers: { '1': '' } } }),
    )
    expect(reset.speakers[1]?.name).toBe('Speaker 2')
    ;({ clip } = await get(BOB, id))
    expect(clip.speakers.map((s) => s.name)).toEqual(['Speaker 1', 'Speaker 2'])
  })

  it('a clip with one speaker names them after the person who recorded it', async () => {
    const one = new FakeClipTranscriber()
    one.transcribe = async () => [{ start: 0, end: 1, text: 'just me', speaker: 0 }]
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    services = createServices(config, { llm, clipTranscriber: one })
    app = createApp(services)
    const { id } = await record(ALICE, webm)
    const { clip } = await get(ALICE, id)
    expect(clip.speakers).toEqual([{ id: 0, name: 'Alice', named: false }])
  })

  it('writes a summary and action items any member can ask for, and keeps them', async () => {
    const { id } = await record(ALICE, webm)
    const summary = await json<Clip>(
      await call('POST', `/api/clips/${id}/ai`, { as: BOB, json: { kind: 'summary' } }),
    )
    expect(summary.aiSummary).toContain('A fake clip that opens with')
    const actions = await json<Clip>(
      await call('POST', `/api/clips/${id}/ai`, { as: ALICE, json: { kind: 'actions' } }),
    )
    expect(actions.aiActions).toBe(
      '- [ ] Follow up on the first point\n- [ ] Reply about all 3 lines',
    )
    expect((await get(BOB, id)).clip.aiSummary).toBe(summary.aiSummary)
  })

  it('refuses AI notes before there is a transcript', async () => {
    const silent = await record(ALICE, silentWebm)
    await json(
      await call('POST', `/api/clips/${silent.id}/ai`, { as: ALICE, json: { kind: 'summary' } }),
      409,
    )
  })

  it('drops images and anything but checklist lines from what the model writes', async () => {
    services.clips.close()
    services.clips.store.close()
    services.index.close()
    services.dictation.store.close()
    const sly = new FakeLLM((req) =>
      req.messages[0]?.content.includes('<task>actions</task>')
        ? '<actions>Sure!\n- [ ] Do it ![x](https://evil.test/?leak)\n* [x] Done one\nignore me</actions>'
        : '<summary_md>Hi ![p](https://evil.test/p.png) there <img src="https://evil.test/q"></summary_md>',
    )
    services = createServices(config, { llm: sly, clipTranscriber: asr })
    app = createApp(services)
    const { id } = await record(ALICE, webm)
    const s1 = await json<Clip>(
      await call('POST', `/api/clips/${id}/ai`, { as: ALICE, json: { kind: 'summary' } }),
    )
    // Images become plain links (nothing fetches them); raw <img> goes entirely.
    expect(s1.aiSummary).toBe('Hi [p](https://evil.test/p.png) there')
    const s2 = await json<Clip>(
      await call('POST', `/api/clips/${id}/ai`, { as: ALICE, json: { kind: 'actions' } }),
    )
    expect(s2.aiActions).toBe('- [ ] Do it [x](https://evil.test/?leak)\n- [ ] Done one')
    expect(s2.aiActions).not.toContain('![')
  })

  it('never overwrites a transcript file already beside a free note path', async () => {
    const { id } = await record(ALICE, webm)
    await json(await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { title: 'Standup' } }))
    const first = await json<{ space: string; path: string }>(
      await call('POST', `/api/clips/${id}/send`, {
        as: ALICE,
        json: { to: 'meeting', transcript: true },
      }),
      201,
    )
    // An orphaned transcript where the next note would go.
    const orphan = first.path.replace(/\.md$/, '-2.transcript.md')
    await services.git.commit(first.space, {
      changes: [{ path: orphan, content: 'keep me' }],
      author: { name: 'Alice', email: ALICE },
      message: 'orphan',
    })
    // Two sends at once take different paths.
    const [a, b] = await Promise.all(
      [0, 1].map(async () =>
        json<{ path: string }>(
          await call('POST', `/api/clips/${id}/send`, {
            as: ALICE,
            json: { to: 'meeting', transcript: true },
          }),
          201,
        ),
      ),
    )
    expect(new Set([a?.path, b?.path]).size).toBe(2)
    expect([a?.path, b?.path]).not.toContain(first.path.replace(/\.md$/, '-2.md'))
    expect((await services.git.readFile(first.space, orphan)).content).toBe('keep me')
  })

  it('sends the clip to a new doc and to a Meetings note in the member’s own space', async () => {
    const { id } = await record(ALICE, webm)
    await json(
      await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { title: 'Pricing bug' } }),
    )
    await json(await call('POST', `/api/clips/${id}/ai`, { as: ALICE, json: { kind: 'actions' } }))
    await json(
      await call('PATCH', `/api/clips/${id}`, { as: ALICE, json: { speakers: { '0': 'Alice' } } }),
    )

    const doc = await json<{ space: string; path: string }>(
      await call('POST', `/api/clips/${id}/send`, {
        as: ALICE,
        json: { to: 'doc', transcript: true },
      }),
      201,
    )
    expect(doc.path).toBe('docs/clips/pricing-bug.md')
    const { content } = await services.git.readFile(doc.space, doc.path)
    expect(content).toMatch(/^---\nid: /)
    expect(content).toContain(`clip: http://localhost:3000/clips/${id}`)
    expect(content).toContain('# Pricing bug')
    expect(content).toContain(`[Watch the clip](http://localhost:3000/clips/${id})`)
    expect(content).toContain('## Action items\n\n- [ ] Follow up on the first point')
    expect(content).toContain('**Alice** [0:00] clip segment 1')
    expect(content).toContain('**Speaker 2** [0:02] clip segment 2')
    const history = await services.git.log(doc.space, { path: doc.path })
    expect(history[0]?.author.email).toBe(ALICE)
    // The space is Alice's own.
    expect(services.spaces.canAccess({ ...(await principalOf(ALICE)) }, doc.space)).toBe(true)
    expect(doc.space).not.toBe('team')

    // Again: a second file beside it, not an overwrite.
    const again = await json<{ path: string }>(
      await call('POST', `/api/clips/${id}/send`, { as: ALICE, json: { to: 'doc' } }),
      201,
    )
    expect(again.path).toBe('docs/clips/pricing-bug-2.md')

    const meeting = await json<{ space: string; path: string }>(
      await call('POST', `/api/clips/${id}/send`, { as: BOB, json: { to: 'meeting' } }),
      201,
    )
    expect(meeting.path).toMatch(/^meetings\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-pricing-bug\.md$/)
    const note = await services.git.readFile(meeting.space, meeting.path)
    expect(note.content).toContain('type: meeting')
    expect(note.content).not.toContain('## Transcript')
    // With the transcript, a Meetings note gets its own transcript file, as Meetings writes one.
    const withTranscript = await json<{ space: string; path: string }>(
      await call('POST', `/api/clips/${id}/send`, {
        as: BOB,
        json: { to: 'meeting', transcript: true },
      }),
      201,
    )
    expect(withTranscript.path).toMatch(/-pricing-bug-2\.md$/)
    const noteText = (await services.git.readFile(withTranscript.space, withTranscript.path))
      .content
    const transcriptName = withTranscript.path.split('/').pop()?.replace(/\.md$/, '.transcript.md')
    expect(noteText).toContain(`transcript: ${transcriptName}`)
    expect(noteText).not.toContain('## Transcript')
    const transcriptFile = await services.git.readFile(
      withTranscript.space,
      withTranscript.path.replace(/\.md$/, '.transcript.md'),
    )
    expect(transcriptFile.content).toContain('# Pricing bug: transcript')
    expect(transcriptFile.content).toContain('[00:00:00] **Alice:** clip segment 1')
    expect(transcriptFile.content).toContain('[00:00:02] **Speaker 2:** clip segment 2')
    // Its unticked items show on Bob's Meetings home.
    const items = await json<Array<{ path: string; items: Array<{ text: string }> }>>(
      await call('GET', '/api/meetings/action-items', { as: BOB }),
    )
    expect(items.find((m) => m.path === meeting.path)?.items.map((i) => i.text)).toContain(
      'Follow up on the first point',
    )
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

  it('the sweep removes a ready clip’s leftover uploads, but not a recording’s', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { id } = await record(ALICE, webm)
    const leftover = join(config.DATA_DIR, 'clips', 'uploads', id)
    await mkdir(leftover, { recursive: true })
    await writeFile(join(leftover, '000000.part'), 'x')
    const live = await json<Clip>(
      await call('POST', '/api/clips', { as: ALICE, json: { mode: 'screen', container: 'webm' } }),
      201,
    )
    await call('PUT', `/api/clips/${live.id}/chunks/0`, { as: ALICE, body: webm })
    await services.clips.sweep()
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(join(config.DATA_DIR, 'clips', 'uploads', live.id))).toBe(true)
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

async function principalOf(email: string) {
  const res = await call('GET', '/api/me', { as: email })
  return ((await res.json()) as { principal: import('../../src/auth/index.js').Principal })
    .principal
}
