import { useEffect, useRef, useState } from 'react'
import { type DictationSettings, dictationApi, type SendKey } from '../api/dictation'
import { useLeaveGuard } from '../hooks/useLeaveGuard'
import { playDictateSound } from '../lib/dictateSounds'
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

/** How long the mic may hear nothing before the page says so (docs/PLAN-dictate-send-and-sounds.md, R7). */
export const SILENT_MIC_MS = 2500
/** How long the words may take before the page says the connection is slow (R7). */
export const SLOW_ANSWER_MS = 4000
/** A level below this, all the way through, is a mic that hears nothing. */
const SILENT_LEVEL = 0.01

const KEY_LABELS: Record<Exclude<SendKey, 'off'>, string> = {
  space: 'Space',
  return: 'Return',
  tab: 'Tab',
}

const KEY_NAMES: Record<Exclude<SendKey, 'off'>, string> = {
  space: ' ',
  return: 'Enter',
  tab: 'Tab',
}

/**
 * Whether a key press is the member's send key (R5): never with ⌘, ⌃ or ⌥, never a repeat, and
 * never while focus is in a text field, where the key types as usual.
 */
export function isSendKey(
  sendKey: SendKey,
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat' | 'target'>,
): boolean {
  if (sendKey === 'off' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key !== KEY_NAMES[sendKey]) return false
  const el = e.target as HTMLElement | null
  if (el && typeof el.closest === 'function') {
    if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
      return false
  }
  return true
}

// The member's choices, asked for once per page load; Space and Soft until the server answers.
let choices: Promise<Pick<DictationSettings, 'sendKey' | 'sounds'>> | null = null
function memberChoices() {
  choices ??= dictationApi.settings().then(
    (s) => ({ sendKey: s.sendKey ?? 'space', sounds: s.sounds ?? 'soft' }),
    () => {
      choices = null
      return { sendKey: 'space' as const, sounds: 'soft' as const }
    },
  )
  return choices
}
/** Forget the cached choices (tests, and after the member changes them). */
export function forgetDictateChoices() {
  choices = null
}

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
  const [notice, setNotice] = useState<string | null>(null)
  const prefs = useRef<Pick<DictationSettings, 'sendKey' | 'sounds'>>({
    sendKey: 'space',
    sounds: 'soft',
  })
  const sent = useRef(false)
  const meter = useRef<{ close: () => void } | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gone = useRef(false)
  // A reload or closing the tab would cut the recording, or the upload of it.
  useLeaveGuard(phase !== 'idle')

  useEffect(() => {
    void memberChoices()
  }, [])

  useEffect(
    () => () => {
      gone.current = true
      if (timer.current) clearTimeout(timer.current)
      meter.current?.close()
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
    setNotice(null)
    sent.current = false
    // Asked for alongside the mic, so the first dictation never waits on the server.
    const asked = memberChoices()
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      prefs.current = await asked
      stream.current = media
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      rec.onstop = async () => {
        for (const t of media.getTracks()) t.stop()
        meter.current?.close()
        meter.current = null
        if (timer.current) clearTimeout(timer.current)
        if (gone.current) return
        playDictateSound(prefs.current.sounds, sent.current ? 'send' : 'stop')
        setPhase('thinking')
        setNotice(null)
        const slow = setTimeout(() => {
          if (!gone.current) setNotice('Slow connection, still writing it up…')
        }, SLOW_ANSWER_MS)
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })
          const { text } = await dictationApi.transcribe(blob)
          if (!gone.current && text.trim()) onText(text.trim())
          else if (!gone.current) onError('Didn’t catch any words. Try again a little closer.')
        } catch (e) {
          if (!gone.current) onError(e instanceof Error ? e.message : 'Dictation failed')
        } finally {
          clearTimeout(slow)
          if (!gone.current) {
            setPhase('idle')
            setNotice(null)
          }
        }
      }
      recorder.current = rec
      rec.start()
      playDictateSound(prefs.current.sounds, 'start')
      setPhase('recording')
      meter.current = watchForSilence(media, () => {
        if (!gone.current && recorder.current?.state === 'recording')
          setNotice('No sound from your microphone. Check it’s on and allowed for this site.')
      })
      timer.current = setTimeout(() => rec.state === 'recording' && rec.stop(), DICTATE_MAX_MS)
    } catch {
      // A microphone that opened before the recorder failed is let go, so nothing (the background
      // music, the browser's mic light) thinks it's still recording.
      if (recorder.current?.state !== 'recording')
        for (const t of stream.current?.getTracks() ?? []) t.stop()
      onError('Couldn’t use the microphone. Allow it in the browser and try again.')
      setPhase('idle')
    }
  }

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  // The send key ends the dictation and adds the words, never submitting anything (R5).
  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent) => {
      if (!isSendKey(prefs.current.sendKey, e)) return
      e.preventDefault()
      e.stopPropagation()
      sent.current = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  const label =
    phase === 'recording'
      ? prefs.current.sendKey === 'off'
        ? 'Stop and add the words'
        : `Stop and add the words (${KEY_LABELS[prefs.current.sendKey]})`
      : phase === 'thinking'
        ? 'Writing it down…'
        : 'Dictate'
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() =>
          phase === 'recording' ? stop() : phase === 'idle' ? void start() : undefined
        }
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
      {notice ? (
        <span role="status" data-testid={`${testId}-notice`} className="text-xs text-ink-soft">
          {notice}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Calls `onSilent` once when the first `SILENT_MIC_MS` of the mic stay below a whisper (R7). A
 * browser without Web Audio says nothing.
 */
function watchForSilence(media: MediaStream, onSilent: () => void): { close: () => void } | null {
  if (typeof AudioContext === 'undefined') return null
  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    return null
  }
  // Outside the click (after the mic's prompt) a browser may start it suspended; a suspended one
  // hears nothing, so it only warns when it was really listening.
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  context.createMediaStreamSource(media).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  let loudest = 0
  const poll = setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    for (const v of samples) loudest = Math.max(loudest, Math.abs(v))
  }, 100)
  const check = setTimeout(() => {
    clearInterval(poll)
    if (context.state === 'running' && loudest < SILENT_LEVEL) onSilent()
  }, SILENT_MIC_MS)
  return {
    close: () => {
      clearInterval(poll)
      clearTimeout(check)
      void context.close().catch(() => undefined)
    },
  }
}
