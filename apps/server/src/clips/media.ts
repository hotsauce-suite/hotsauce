import { execFile } from 'node:child_process'
import { setPriority } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HearthError } from '../errors.js'
import type { ClipContainer } from './store.js'

const run = promisify(execFile)

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

export interface Probe {
  durationMs: number
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
}

const ProbeOutput = z.object({
  format: z.object({ duration: z.string().optional() }).partial().optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        duration: z.string().optional(),
      }),
    )
    .default([]),
})

// Remuxing an hour copies bytes, it doesn't encode; minutes means ffmpeg is stuck.
const FFMPEG_TIMEOUT_MS = 10 * 60_000

async function ffmpeg(
  paths: FfmpegPaths,
  args: string[],
  timeoutMs = FFMPEG_TIMEOUT_MS,
  background = false,
): Promise<void> {
  try {
    const running = run(
      paths.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    )
    // A long encode yields the CPU to requests: the box serves pages while it works.
    if (background && running.child.pid !== undefined) {
      try {
        setPriority(running.child.pid, COMPOSITE_NICE)
      } catch {
        // Not allowed here (some containers): it just runs at normal priority.
      }
    }
    await running
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    const reason = stderr.trim().split('\n').slice(-3).join(' | ') || (err as Error).message
    throw new HearthError('internal', `ffmpeg failed: ${reason.slice(0, 500)}`)
  }
}

/**
 * MediaRecorder's output, made seekable: WebM gets cues and a duration, MP4 (fragmented) becomes a
 * plain MP4 with its index at the front so playback starts before the whole file arrives. Copies
 * the streams; nothing is re-encoded.
 */
export async function remux(
  paths: FfmpegPaths,
  input: string,
  output: string,
  container: ClipContainer,
): Promise<void> {
  const muxer = container === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'webm']
  // genpts fills in timestamps a recording paused part way can leave out.
  await ffmpeg(paths, [
    '-fflags',
    '+genpts',
    '-i',
    input,
    '-map',
    '0',
    '-c',
    'copy',
    ...muxer,
    output,
  ])
}

export async function probe(paths: FfmpegPaths, file: string): Promise<Probe> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      paths.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    ))
  } catch (err) {
    throw new HearthError('internal', `ffprobe failed: ${(err as Error).message.slice(0, 300)}`)
  }
  const out = ProbeOutput.parse(JSON.parse(stdout))
  const video = out.streams.find((s) => s.codec_type === 'video')
  const audio = out.streams.find((s) => s.codec_type === 'audio')
  const seconds = Number(out.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  }
}

/** A JPEG of one frame, 640 px wide, from a second in (or the middle of a shorter clip). */
export async function thumbnail(
  paths: FfmpegPaths,
  input: string,
  output: string,
  durationMs: number,
): Promise<void> {
  const at = Math.min(1, durationMs / 2000).toFixed(2)
  await ffmpeg(paths, [
    '-ss',
    at,
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-2',
    '-q:v',
    '4',
    output,
  ])
}

/** The sound alone, as 16 kHz mono FLAC: small, lossless, and every speech service reads it. */
export async function extractAudio(paths: FfmpegPaths, input: string, output: string) {
  await ffmpeg(paths, ['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', output])
}

/** The composite's height: the screen's, at most 1080 (a 5K screen re-encoded would take hours). */
export const COMPOSITE_MAX_HEIGHT = 1080
/**
 * One shared vCPU in production: one thread, at the lowest priority, so the web server, Meetings'
 * sockets and Dictate always come first; a composite just takes longer.
 */
export const COMPOSITE_THREADS = 1
export const COMPOSITE_NICE = 19

/** Sizes of the camera bubble for a video `height` px tall: diameter, margin and ring, all even. */
export function bubbleGeometry(height: number): { size: number; margin: number; ring: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return {
    size: even(height * 0.24),
    margin: even(height * 0.035),
    ring: even(Math.max(2, height * 0.006)),
  }
}

/**
 * The screen recording with the camera in a round bubble at the bottom left: H.264 and AAC in a
 * faststart MP4, at most 1080 p. The camera starts `offsetMs` after the screen (earlier when
 * negative); once it ends the screen carries on alone. Masks are drawn once as PNGs, so ffmpeg only
 * blends per frame. Re-encodes, so it takes a while: allowed a few times the clip's length.
 */
export async function composite(
  paths: FfmpegPaths,
  args: {
    screen: string
    camera: string
    output: string
    workDir: string
    screenHeight: number
    offsetMs: number
    durationMs: number
    /** Tuning for the experiments in the plan; production uses the defaults. */
    maxHeight?: number
    preset?: string
    threads?: number
  },
): Promise<void> {
  const height = Math.min(
    args.maxHeight ?? COMPOSITE_MAX_HEIGHT,
    Math.max(2, Math.round(args.screenHeight / 2) * 2),
  )
  const threads = String(args.threads ?? COMPOSITE_THREADS)
  const { size, margin, ring } = bubbleGeometry(height)
  const outer = size + 2 * ring
  const mask = `${args.workDir}/mask.png`
  const halo = `${args.workDir}/ring.png`
  // White disc on black: the camera's alpha.
  await ffmpeg(paths, [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${size}x${size}:d=1,format=gray,geq=lum='if(lte(hypot(X-${size / 2 - 0.5},Y-${size / 2 - 0.5}),${size / 2 - 0.5}),255,0)'`,
    '-frames:v',
    '1',
    mask,
  ])
  // A warm paper-coloured ring around it, transparent elsewhere.
  const c = outer / 2 - 0.5
  await ffmpeg(paths, [
    '-f',
    'lavfi',
    '-i',
    `color=c=0xF2EADF:s=${outer}x${outer}:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(hypot(X-${c},Y-${c}),${size / 2 - 1},${outer / 2 - 0.5}),255,0)'`,
    '-frames:v',
    '1',
    halo,
  ])
  const offset = args.offsetMs / 1000
  const cameraTiming =
    offset >= 0 ? ['-itsoffset', offset.toFixed(3)] : ['-ss', (-offset).toFixed(3)]
  const filter = [
    `[0:v]scale=-2:${height}:flags=bilinear,setsar=1,format=yuv420p[bg]`,
    `[1:v]crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size},setsar=1,format=yuva420p[cam]`,
    '[2:v]format=gray[mask]',
    '[cam][mask]alphamerge=shortest=1[disc]',
    `[disc]pad=${outer}:${outer}:${ring}:${ring}:color=black@0[padded]`,
    '[padded][3:v]overlay=0:0:shortest=1[bubble]',
    `[bg][bubble]overlay=x=${margin - ring}:y=H-h-${margin - ring}:eof_action=pass:format=auto[v]`,
  ].join(';')
  const timeoutMs = Math.max(FFMPEG_TIMEOUT_MS, args.durationMs * 8)
  await ffmpeg(
    paths,
    [
      '-filter_complex_threads',
      '1',
      '-threads',
      threads,
      '-i',
      args.screen,
      '-threads',
      '1',
      ...cameraTiming,
      '-i',
      args.camera,
      '-loop',
      '1',
      '-i',
      mask,
      '-loop',
      '1',
      '-i',
      halo,
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      args.preset ?? 'veryfast',
      '-crf',
      '26',
      // A short lookahead and one thread keep ffmpeg to a couple of hundred MB on a 1 GB box.
      '-threads',
      threads,
      '-x264-params',
      'rc-lookahead=10',
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'vfr',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      args.output,
    ],
    timeoutMs,
    true,
  )
}
