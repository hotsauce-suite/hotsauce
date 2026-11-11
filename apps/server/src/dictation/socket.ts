import { ulid } from 'ulid'
import { z } from 'zod'
import type { Authenticator, Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type {
  Transcriber,
  TranscriberSession,
  TranscriptSegment,
} from '../meetings/transcriber/types.js'
import { authenticateDevice } from './device-auth.js'
import { type Dictation, MAX_DICTATION_MS } from './service.js'

/** 16 kHz mono PCM16: 32 bytes a millisecond. */
const PCM_BYTES_PER_MS = 32
const MAX_STREAM_BYTES = MAX_DICTATION_MS * PCM_BYTES_PER_MS
/** Audio sent before the stream is ready (auth, Deepgram's handshake) is held, up to 30 s. */
const MAX_EARLY_BYTES = 30_000 * PCM_BYTES_PER_MS
/** A stream that goes quiet (a Mac asleep, a dropped network) is ended, Deepgram included. */
const IDLE_MS = 20_000
/** And none outlives the longest dictation, whatever it sends. */
const MAX_LIFETIME_MS = MAX_DICTATION_MS + 60_000

const Start = z.object({
  type: z.literal('start'),
  token: z.string().min(1),
  mode: z.enum(['clean', 'literal']).default('clean'),
  app_name: z.string().max(200).optional(),
  app_bundle: z.string().max(200).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
    .optional(),
})
const Control = z.object({ type: z.enum(['finish', 'cancel']) })

/** Close codes, so the Mac can tell "connect again" from "try the upload instead". */
export const WS_DICTATION_UNAUTHORIZED = 4401
export const WS_DICTATION_FORBIDDEN = 4403
export const WS_DICTATION_RATE_LIMITED = 4429
export const WS_DICTATION_FAILED = 4500

export interface DictationSocket {
  send(data: string): void
  close(code: number, reason: string): void
}

type Phase = 'auth' | 'starting' | 'streaming' | 'finishing' | 'done'

/**
 * `/ws/dictation` (ARCHITECTURE §9.2): the Mac streams 16 kHz PCM while the member speaks, so on
 * key-up only Deepgram's last words and the cleanup remain. The first message is
 * `{ type: 'start', token, mode, app_name?, app_bundle?, language? }` (a device token; the
 * socket is the third thing one can do); then binary audio; then `{ type: 'finish' }`, answered
 * by `{ type: 'result', ...DictateResult }`, or `{ type: 'cancel' }`. Any failure is
 * `{ type: 'error', code, message }` and a close, and the Mac uploads the audio instead.
 */
export class DictationSocketServer {
  readonly #dictation: Dictation
  readonly #auth: Pick<Authenticator, 'principalForUser'>
  readonly #transcriber: Transcriber
  readonly #authTimeoutMs: number
  readonly #idleMs: number

  constructor(opts: {
    dictation: Dictation
    auth: Pick<Authenticator, 'principalForUser'>
    transcriber: Transcriber
    authTimeoutMs?: number
    idleMs?: number
  }) {
    this.#dictation = opts.dictation
    this.#auth = opts.auth
    this.#transcriber = opts.transcriber
    this.#authTimeoutMs = opts.authTimeoutMs ?? 5_000
    this.#idleMs = opts.idleMs ?? IDLE_MS
  }

  connect(socket: DictationSocket): {
    text(data: string): void
    binary(data: Uint8Array): void
    closed(): void
  } {
    let phase: Phase = 'auth'
    let principal: Principal | null = null
    let start: z.infer<typeof Start> | null = null
    let session: TranscriberSession | null = null
    let bytes = 0
    const early: Uint8Array[] = []
    let earlyBytes = 0
    let finishRequested = false
    const finals: TranscriptSegment[] = []

    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const stopTimers = () => {
      clearTimeout(timer)
      clearTimeout(idleTimer)
      clearTimeout(lifetimeTimer)
    }
    const fail = (err: unknown) => {
      if (phase === 'done') return
      phase = 'done'
      stopTimers()
      const error =
        err instanceof HearthError
          ? err
          : new HearthError('asr_error', 'The dictation stream failed')
      if (!(err instanceof HearthError)) {
        console.error(`dictation stream failed: ${err instanceof Error ? err.name : 'error'}`)
      }
      socket.send(JSON.stringify({ type: 'error', code: error.code, message: error.message }))
      socket.close(closeCodeFor(error), error.code)
      void session?.finish().catch(() => {})
    }

    const timer = setTimeout(() => {
      if (phase === 'auth') fail(new HearthError('unauthorized', 'No start message'))
    }, this.#authTimeoutMs)
    const lifetimeTimer = setTimeout(
      () => fail(new HearthError('bad_request', 'A dictation can be at most 10 minutes')),
      MAX_LIFETIME_MS,
    )
    const stillHearing = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (phase === 'starting' || phase === 'streaming') {
          fail(new HearthError('asr_error', 'No audio for 20 seconds'))
        }
      }, this.#idleMs)
    }

    const finish = async () => {
      if (!session || !principal || !start) return
      phase = 'finishing'
      clearTimeout(idleTimer)
      const finishedAt = performance.now()
      await session.finish()
      // Closed, cancelled or failed while Deepgram flushed: don't pay for a cleanup no one gets.
      if (phase !== 'finishing') return
      const transcript = finals
        .sort((a, b) => a.at - b.at)
        .map((s) => s.text)
        .join(' ')
      const result = await this.#dictation.finish(principal, {
        transcript,
        durationMs: Math.round(bytes / PCM_BYTES_PER_MS),
        // What the member waits for after key-up: Deepgram's last words, not the whole audio.
        asrMs: Math.round(performance.now() - finishedAt),
        bytes,
        mode: start.mode,
        appName: start.app_name,
        appBundle: start.app_bundle,
        via: 'stream',
      })
      if (phase !== 'finishing') return
      phase = 'done'
      stopTimers()
      socket.send(JSON.stringify({ type: 'result', ...result }))
      socket.close(1000, 'done')
    }

    const begin = async (message: z.infer<typeof Start>) => {
      phase = 'starting'
      start = message
      const device = await authenticateDevice(this.#auth, this.#dictation.store, message.token)
      if (phase !== 'starting') return // closed while we checked the token
      principal = device.principal
      this.#dictation.takeSlot(principal)
      stillHearing()
      session = await this.#transcriber.start({
        sessionId: `dictation-${ulid()}`,
        vocabulary: this.#dictation.keyterms(principal),
        ...(message.language ? { language: message.language } : {}),
        failOnDrop: true,
      })
      session.on('segment', (segment) => {
        if (segment.final && segment.track === 'me') finals.push(segment)
      })
      session.on('error', fail)
      if (phase !== 'starting') {
        // Closed or failed while we were connecting.
        void session.finish().catch(() => {})
        return
      }
      phase = 'streaming'
      for (const chunk of early) session.sendAudio('me', chunk)
      early.length = 0
      socket.send(JSON.stringify({ type: 'ready' }))
      if (finishRequested) await finish()
    }

    return {
      text: (data) => {
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          return fail(new HearthError('bad_request', 'Not JSON'))
        }
        if (phase === 'auth') {
          const message = Start.safeParse(json)
          if (!message.success)
            return fail(new HearthError('unauthorized', 'Start with a device token'))
          clearTimeout(timer)
          begin(message.data).catch(fail)
          return
        }
        const control = Control.safeParse(json)
        if (!control.success) return fail(new HearthError('bad_request', 'Unknown message'))
        if (control.data.type === 'cancel') {
          phase = 'done'
          stopTimers()
          void session?.finish().catch(() => {})
          socket.close(1000, 'cancelled')
          return
        }
        if (phase === 'starting') {
          finishRequested = true
          return
        }
        if (phase === 'streaming') finish().catch(fail)
      },

      binary: (data) => {
        if (phase === 'done' || phase === 'finishing' || phase === 'auth') return
        stillHearing()
        bytes += data.length
        if (bytes > MAX_STREAM_BYTES) {
          return fail(new HearthError('bad_request', 'A dictation can be at most 10 minutes'))
        }
        if (phase === 'streaming' && session) {
          session.sendAudio('me', data)
          return
        }
        earlyBytes += data.length
        if (earlyBytes > MAX_EARLY_BYTES) {
          return fail(
            new HearthError('asr_error', 'The transcription service took too long to start'),
          )
        }
        early.push(data)
      },

      closed: () => {
        stopTimers()
        if (phase === 'done') return
        phase = 'done'
        void session?.finish().catch(() => {})
      },
    }
  }
}

function closeCodeFor(error: HearthError): number {
  switch (error.code) {
    case 'unauthorized':
      return WS_DICTATION_UNAUTHORIZED
    case 'domain_not_allowed':
    case 'forbidden':
      return WS_DICTATION_FORBIDDEN
    case 'rate_limited':
      return WS_DICTATION_RATE_LIMITED
    default:
      return WS_DICTATION_FAILED
  }
}
