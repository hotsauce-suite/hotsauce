import { useEffect, useRef, useState } from 'react'
import { dictationApi } from '../api/dictation'
import { Icon } from './Icon'

/** A dictation stops itself after this long. */
export const DICTATE_MAX_MS = 5 * 60_000
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav']

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return undefined
  return AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
}

type Phase = 'idle' | 'recording' | 'thinking'

/**
 * Dictate into a text box: press to speak, press again to stop. The recording goes to Dictate's
 * transcribe route (cleaned up, with the member's word lists) and the words come back through
 * `onText`. Nothing is kept on the server.
 */
export function DictateButton({
  onText,
  onError,
  testId = 'dictate',
}: {
  onText: (text: string) => void
  onError: (message: string) => void
  testId?: string
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gone = useRef(false)

  useEffect(
    () => () => {
      gone.current = true
      if (timer.current) clearTimeout(timer.current)
      recorder.current?.state === 'recording' && recorder.current.stop()
      for (const t of stream.current?.getTracks() ?? []) t.stop()
    },
    [],
  )

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('This browser can’t record. Type your answer instead.')
      return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = media
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      rec.onstop = async () => {
        for (const t of media.getTracks()) t.stop()
        if (timer.current) clearTimeout(timer.current)
        if (gone.current) return
        setPhase('thinking')
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })
          const { text } = await dictationApi.transcribe(blob)
          if (!gone.current && text.trim()) onText(text.trim())
          else if (!gone.current) onError('Didn’t catch any words. Try again a little closer.')
        } catch (e) {
          if (!gone.current) onError(e instanceof Error ? e.message : 'Dictation failed')
        } finally {
          if (!gone.current) setPhase('idle')
        }
      }
      recorder.current = rec
      rec.start()
      setPhase('recording')
      timer.current = setTimeout(() => rec.state === 'recording' && rec.stop(), DICTATE_MAX_MS)
    } catch {
      onError('Couldn’t use the microphone. Allow it in the browser and try again.')
      setPhase('idle')
    }
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  const label =
    phase === 'recording'
      ? 'Stop and add the words'
      : phase === 'thinking'
        ? 'Writing it down…'
        : 'Dictate'
  return (
    <button
      type="button"
      onClick={() => (phase === 'recording' ? stop() : phase === 'idle' ? void start() : undefined)}
      disabled={phase === 'thinking'}
      aria-pressed={phase === 'recording'}
      data-testid={testId}
      data-phase={phase}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
        phase === 'recording'
          ? 'border-ember bg-ember-wash text-ink'
          : 'border-ash text-ink-soft hover:bg-paper-sunk hover:text-ink'
      }`}
    >
      <Icon name={phase === 'recording' ? 'stop' : 'mic'} className="size-3.5" />
      {label}
    </button>
  )
}
