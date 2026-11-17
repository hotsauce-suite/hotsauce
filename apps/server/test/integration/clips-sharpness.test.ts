// Screen recordings stay sharp after the camera is put in and after a trim (ARCHITECTURE §10.5,
// §10.6): a Retina-sized screen keeps its full height, and fine detail isn't smeared.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composite, cutVideo, probe } from '../../src/clips/index.js'
import { COMPOSITE_MAX_HEIGHT } from '../../src/clips/media.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

const run = promisify(execFile)
const FFMPEG = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
const [W, H] = [2464, 1600]

let dir: string
let screen: string
let camera: string

/** One pixel's grey level at (x, y), 1 s in. */
async function grey(file: string, x: number, y: number): Promise<number> {
  const { stdout } = await run(
    'ffmpeg',
    [
      ...['-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1'],
      ...['-vf', `crop=1:1:${x}:${y},format=gray`, '-f', 'rawvideo', '-'],
    ],
    { encoding: 'buffer' },
  )
  return (stdout as Buffer)[0] ?? 0
}

beforeAll(async () => {
  dir = await makeTempDir('hotsauce-clip-sharp-')
  screen = join(dir, 'screen.webm')
  camera = join(dir, 'camera.webm')
  // Black and white stripes 2 px wide: what small text looks like to a scaler.
  await run('ffmpeg', [
    ...['-y', '-loglevel', 'error', '-f', 'lavfi'],
    ...[
      '-i',
      `color=c=black:s=${W}x${H}:r=10:d=2,format=gray,geq=lum='if(mod(floor(X/2),2),255,0)'`,
    ],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
    ...['-c:v', 'libvpx', '-b:v', '20M', '-c:a', 'libopus', '-f', 'webm', screen],
  ])
  await run('ffmpeg', [
    ...['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10:d=2'],
    ...['-c:v', 'libvpx', '-an', '-f', 'webm', camera],
  ])
}, 60_000)

afterAll(async () => {
  await removeDir(dir)
})

describe('clip sharpness', () => {
  it('keeps a Retina-sized screen at its own height', () => {
    expect(COMPOSITE_MAX_HEIGHT).toBeGreaterThanOrEqual(H)
  })

  it('puts the camera in without scaling the screen down or smearing fine detail', async () => {
    const output = join(dir, 'composite.mp4')
    await composite(FFMPEG, {
      screen,
      camera,
      output,
      workDir: dir,
      screenHeight: H,
      offsetMs: 0,
      durationMs: 2000,
    })
    const info = await probe(FFMPEG, output)
    expect([info.width, info.height]).toEqual([W, H])
    // Top right, away from the bubble: neighbouring stripes are still black and white.
    const [a, b] = [await grey(output, W - 40, 40), await grey(output, W - 38, 40)]
    expect(Math.abs(a - b)).toBeGreaterThan(150)
  }, 120_000)

  it('trims without scaling the screen down or smearing fine detail', async () => {
    const output = join(dir, 'edited.mp4')
    await cutVideo(FFMPEG, {
      input: screen,
      output,
      keep: [{ start: 0, end: 1.5 }],
      hasVideo: true,
      hasAudio: true,
      height: H,
      durationMs: 2000,
    })
    const info = await probe(FFMPEG, output)
    expect([info.width, info.height]).toEqual([W, H])
    const [a, b] = [await grey(output, 100, 100), await grey(output, 102, 100)]
    expect(Math.abs(a - b)).toBeGreaterThan(150)
  }, 120_000)
})
