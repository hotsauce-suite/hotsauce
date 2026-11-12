import { HearthError } from '../errors.js'

/** Text to speech for Briefcast (plan `docs/plans/2026-11-12-briefcast.md`). Returns MP3 bytes. */
export interface Speaker {
  readonly kind: 'fake' | 'openai' | 'none'
  /** The voice's name, recorded with each episode. */
  readonly voice: string
  speak(text: string): Promise<Uint8Array>
}

/** OpenAI's speech endpoint takes at most 4096 characters per request; stay well under. */
export const MAX_CHUNK_CHARS = 3_000

const INSTRUCTIONS =
  'You are reading a private morning briefing to one colleague. Warm, calm and clear, like a ' +
  'trusted chief of staff. Natural pace, short pauses between topics, never rushed or salesy.'

/**
 * OpenAI text to speech (`/v1/audio/speech`). Long scripts are split at paragraph or sentence
 * boundaries and the MP3s joined: MP3 is a stream of independent frames, so the joined file plays
 * as one.
 */
export class OpenAISpeaker implements Speaker {
  readonly kind = 'openai' as const
  readonly voice: string
  readonly #apiKey: string
  readonly #model: string
  readonly #fetch: typeof fetch

  constructor(opts: { apiKey: string; model: string; voice: string; fetch?: typeof fetch }) {
    this.#apiKey = opts.apiKey
    this.#model = opts.model
    this.voice = opts.voice
    this.#fetch = opts.fetch ?? fetch
  }

  async speak(text: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    for (const chunk of splitForSpeech(text, MAX_CHUNK_CHARS)) parts.push(await this.#one(chunk))
    // A lone part plays as OpenAI made it. Joined parts lose their tags and header frames, whose
    // frame counts would describe one part only (Safari and Apple Podcasts trust them).
    return parts.length === 1 ? (parts[0] as Uint8Array) : concat(parts.map(bareFrames))
  }

  async #one(input: string): Promise<Uint8Array> {
    let res: Response
    try {
      res = await this.#fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.#model,
          voice: this.voice,
          input,
          instructions: INSTRUCTIONS,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (err) {
      console.error(`briefcast: text to speech request failed: ${errorText(err)}`)
      throw new HearthError('llm_error', 'The voice service couldn’t be reached')
    }
    if (!res.ok) {
      // The detail stays in the server log: OpenAI's errors can name part of the key.
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      console.error(`briefcast: text to speech failed (${res.status}): ${detail}`)
      throw new HearthError('llm_error', `The voice service refused the request (${res.status})`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** Development and tests: about a second of silent MP3 per call, so pages and feeds work. */
export class FakeSpeaker implements Speaker {
  readonly kind = 'fake' as const
  readonly voice = 'fake'
  readonly calls: string[] = []

  async speak(text: string): Promise<Uint8Array> {
    this.calls.push(text)
    return silentMp3(38)
  }
}

/** No key yet: Briefcast writes the script and says the voice needs a key. */
export class UnconfiguredSpeaker implements Speaker {
  readonly kind = 'none' as const
  readonly voice = ''

  async speak(): Promise<Uint8Array> {
    throw new HearthError('not_configured', 'Briefcast audio needs an OpenAI key')
  }
}

/** Splits at paragraph, then sentence, then word boundaries, each piece at most `max` chars. */
export function splitForSpeech(text: string, max: number): string[] {
  const pieces: string[] = []
  let current = ''
  const push = (s: string) => {
    if (current === '') current = s
    else if (current.length + 2 + s.length <= max) current = `${current}\n\n${s}`
    else {
      pieces.push(current)
      current = s
    }
  }
  for (const para of text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (para.length <= max) {
      push(para)
      continue
    }
    for (const sentence of para.match(/[^.!?]+[.!?]*\s*/g) ?? [para]) {
      let s = sentence.trim()
      while (s.length > max) {
        const cut = s.lastIndexOf(' ', max)
        const at = cut > 0 ? cut : max
        push(s.slice(0, at))
        s = s.slice(at).trim()
      }
      if (s) push(s)
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/**
 * Seconds of audio in an MP3, from its first frame's bitrate (OpenAI's MP3 is constant bitrate).
 * Null when no frame header is found.
 */
export function mp3Seconds(bytes: Uint8Array): number | null {
  for (let i = 0; i + 4 <= bytes.length && i < 64 * 1024; i++) {
    if (bytes[i] !== 0xff || ((bytes[i + 1] ?? 0) & 0xe0) !== 0xe0) continue
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const version = (b1 >> 3) & 0b11 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b1 >> 1) & 0b11 // 1 = Layer III
    const index = (b2 >> 4) & 0x0f
    if (layer !== 1 || version === 1 || index === 0 || index === 15) continue
    const table = version === 3 ? MPEG1_L3 : MPEG2_L3
    const kbps = table[index] ?? 0
    if (kbps === 0) continue
    return Math.round(((bytes.length - i) * 8) / (kbps * 1000))
  }
  return null
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/** `frames` silent MPEG-1 Layer III frames, 128 kbit/s, 44.1 kHz mono (26 ms each). */
export function silentMp3(frames: number): Uint8Array {
  const size = 417
  const out = new Uint8Array(size * frames)
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0xc4], f * size)
  return out
}

/** The MP3's audio frames only: a leading ID3v2 tag and a Xing/Info/VBRI header frame removed. */
export function bareFrames(bytes: Uint8Array): Uint8Array {
  let at = 0
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
    const size =
      (((bytes[6] ?? 0) & 0x7f) << 21) |
      (((bytes[7] ?? 0) & 0x7f) << 14) |
      (((bytes[8] ?? 0) & 0x7f) << 7) |
      ((bytes[9] ?? 0) & 0x7f)
    const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0
    at = Math.min(bytes.length, 10 + size + footer)
  }
  const length = frameLength(bytes, at)
  if (length !== null) {
    const frame = bytes.subarray(at, Math.min(bytes.length, at + length))
    const tag = (s: string) => {
      const want = [...s].map((c) => c.charCodeAt(0))
      for (let i = 4; i + 4 <= Math.min(frame.length, 64); i++) {
        if (want.every((b, k) => frame[i + k] === b)) return true
      }
      return false
    }
    if (tag('Xing') || tag('Info') || tag('VBRI')) at += length
  }
  return bytes.subarray(at)
}

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
}

/** Length in bytes of the Layer III frame whose header starts at `at`, or null. */
function frameLength(bytes: Uint8Array, at: number): number | null {
  if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xe0) !== 0xe0) return null
  const b1 = bytes[at + 1] ?? 0
  const b2 = bytes[at + 2] ?? 0
  const version = (b1 >> 3) & 0b11
  if (((b1 >> 1) & 0b11) !== 1 || version === 1) return null
  const kbps = (version === 3 ? MPEG1_L3 : MPEG2_L3)[(b2 >> 4) & 0x0f] ?? 0
  const rate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0b11] ?? 0
  if (kbps === 0 || rate === 0) return null
  const padding = (b2 >> 1) & 1
  return Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + padding
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
