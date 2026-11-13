// What a clip records from (ARCHITECTURE §10.3): the screen, the camera and the microphone, with
// the shared tab's or system audio mixed in when the share picker offers it.

import type { ClipContainer, ClipMode } from '../../../api/clips'

/** Bits per second. Screen content compresses well; this keeps an hour near 1 GB. */
export const VIDEO_BITS = 2_500_000
export const AUDIO_BITS = 128_000
/** The camera's own track: it ends up a 260 px bubble, so a modest rate is plenty. */
export const CAMERA_BITS = 1_000_000

export interface RecordingFormat {
  mimeType: string
  container: ClipContainer
}

// MP4 first: H.264 and AAC play everywhere a teammate might open the link, Safari and iPhones
// included. WebM where Chrome can't record MP4.
const CANDIDATES: RecordingFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', container: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,opus', container: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm' },
  { mimeType: 'video/webm', container: 'webm' },
]

/** The first format this browser can record, or null when it can't record video at all. */
export function pickFormat(
  isSupported: (type: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): RecordingFormat | null {
  return CANDIDATES.find((f) => isSupported(f.mimeType)) ?? null
}

// The camera track has no sound: the same containers, video codecs only.
const CAMERA_CANDIDATES: RecordingFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.640028', container: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', container: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', container: 'webm' },
  { mimeType: 'video/webm', container: 'webm' },
]

/** The camera track's format, or null when the browser can't record one. */
export function pickCameraFormat(
  isSupported: (type: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): RecordingFormat | null {
  return CAMERA_CANDIDATES.find((f) => isSupported(f.mimeType)) ?? null
}

/** Whether this browser can record clips at all (a computer's Chrome or Edge, in practice). */
export function canRecord(mode: ClipMode): boolean {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) return false
  return mode === 'camera' || typeof navigator.mediaDevices.getDisplayMedia === 'function'
}

export function isDenied(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
  )
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

export async function getCamera(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  })
}

export async function getMic(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
}

/**
 * Chrome's share picker. Not awaited before the camera bubble's window is asked for: both need
 * the click's activation, and the picker is asked first so it never goes without.
 */
export function requestDisplay(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, displaySurface: 'monitor' },
    audio: true,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions)
}

export interface MixedAudio {
  track: MediaStreamTrack | null
  close: () => void
}

/**
 * One audio track from the mic and the share's sound. Two sources are mixed with WebAudio; one
 * is used as it is. Audio isn't throttled in a background tab, unlike timers and canvas.
 */
export function mixAudio(sources: Array<MediaStream | null>): MixedAudio {
  const tracks = sources.flatMap((s) => s?.getAudioTracks() ?? [])
  if (tracks.length === 0) return { track: null, close: () => {} }
  if (tracks.length === 1) return { track: tracks[0] as MediaStreamTrack, close: () => {} }
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  for (const track of tracks) {
    context.createMediaStreamSource(new MediaStream([track])).connect(destination)
  }
  return {
    track: destination.stream.getAudioTracks()[0] ?? null,
    close: () => void context.close().catch(() => {}),
  }
}

export interface Devices {
  cameras: MediaDeviceInfo[]
  mics: MediaDeviceInfo[]
}

/** Cameras and microphones, with names once the page has been allowed to use one of each. */
export async function listDevices(): Promise<Devices> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return {
    cameras: all.filter((d) => d.kind === 'videoinput' && d.deviceId),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId),
  }
}
