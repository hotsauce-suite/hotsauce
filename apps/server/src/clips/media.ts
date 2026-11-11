import { execFile } from 'node:child_process'
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

async function ffmpeg(paths: FfmpegPaths, args: string[]): Promise<void> {
  try {
    await run(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
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
