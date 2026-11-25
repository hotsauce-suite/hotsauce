import type { SavedMark } from '@hotsauce/format'
import { MAX_DRAWN_SIGNATURE_CHARS } from '@hotsauce/format'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { inputClass } from '../../routes/org/fields'
import { primaryButton, secondaryButton } from '../meetings/components/common'
import { DEFAULT_STRENGTH, type Prepared, prepare } from './cleanSignature'
import {
  MAX_UPLOAD_BYTES,
  readPicture,
  signatureFromPicture,
  UPLOAD_ACCEPT,
} from './uploadSignature'

/** What goes on a field: typed text, or a drawn or uploaded PNG data URL. */
export type Signature =
  | { value: string; input: 'typed' }
  | { image: string; input: 'drawn' | 'uploaded' }

type Mode = 'saved' | 'type' | 'draw' | 'upload'

const MODE_LABEL: Record<Mode, string> = {
  saved: 'Saved',
  type: 'Type',
  draw: 'Draw',
  upload: 'Upload',
}

/** A saved signature or initials, as it looks on the page. */
export function MarkPreview({ mark, className = '' }: { mark: SavedMark; className?: string }) {
  return mark.input === 'typed' ? (
    <span className={`sign-script block truncate text-4xl text-ink ${className}`}>
      {mark.value}
    </span>
  ) : (
    <img src={mark.image} alt="" className={`max-h-24 max-w-full object-contain ${className}`} />
  )
}

/**
 * Type, draw or upload a signature (or initials), or use the one saved before. Members can save
 * what they make for next time (docs/PLAN-sign-saved-signature.md); people signing from a link
 * can't, since they have no account.
 */
export function SignatureDialog({
  kind,
  name,
  saved = null,
  canSave = false,
  saving = false,
  onDone,
  onClose,
}: {
  kind: 'signature' | 'initials'
  name: string
  /** The member's saved one of this kind, offered first. */
  saved?: SavedMark | null
  /** Whether to offer "Save for next time" (members only). */
  canSave?: boolean
  /** Opened from "Your signature" to save one, not to sign a document. */
  saving?: boolean
  /** `save` is true when they asked to keep it for next time. */
  onDone: (s: Signature, save: boolean) => void
  onClose: () => void
}) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
  const modes: Mode[] = saved ? ['saved', 'type', 'draw', 'upload'] : ['type', 'draw', 'upload']
  const [mode, setMode] = useState<Mode>(saved ? 'saved' : 'type')
  const [typed, setTyped] = useState(kind === 'initials' ? initials : name)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  const [tooBig, setTooBig] = useState(false)
  const [save, setSave] = useState(true)
  const drawing = useRef(false)
  const label = kind === 'initials' ? 'initials' : 'signature'

  // Upload: the picture as read, the Ink slider, and the cleaned result.
  const [picture, setPicture] = useState<Prepared | null>(null)
  const [strength, setStrength] = useState(DEFAULT_STRENGTH)
  const [pickError, setPickError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // The slider moves at once; the cleanup catches up when the drag pauses.
  const settled = useDeferredValue(strength)
  const uploaded = useMemo(
    () => (picture ? signatureFromPicture(picture, settled, label) : null),
    [picture, settled, label],
  )
  // Only the picture picked last counts, whichever finishes reading first.
  const picks = useRef(0)

  // A saved one that loads after the box opened: show it, unless they already started.
  const touched = useRef(false)
  useEffect(() => {
    if (saved && !touched.current) setMode('saved')
  }, [saved])

  const pick = async (file: File | null | undefined) => {
    if (!file) return
    setPickError(null)
    if (file.size > MAX_UPLOAD_BYTES) {
      setPickError('That file is over 25 MB. Pick a smaller picture.')
      return
    }
    const mine = ++picks.current
    setReading(true)
    const px = await readPicture(file)
    if (mine !== picks.current) return
    setReading(false)
    if (!px) {
      setPickError(
        'That picture couldn’t be opened here. Try a PNG or JPG (a screenshot of it works too).',
      )
      return
    }
    setStrength(DEFAULT_STRENGTH)
    setPicture(prepare(px))
  }

  // Paste a picture while the Upload tab is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick only sets state
  useEffect(() => {
    if (mode !== 'upload') return
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void pick(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [mode])

  useEffect(() => {
    if (mode !== 'draw' || !canvas.current) return
    const el = canvas.current
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    el.width = el.clientWidth * ratio
    el.height = el.clientHeight * ratio
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 3.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Blue-black pen ink, thick enough to stay dark once shrunk into a field.
    ctx.strokeStyle = '#050a1a'
    setDrawn(false)
  }, [mode])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const ready =
    mode === 'saved'
      ? saved !== null
      : mode === 'type'
        ? Boolean(typed.trim())
        : mode === 'draw'
          ? drawn
          : uploaded?.ok === true

  const finish = () => {
    if (mode === 'saved' && saved) {
      onDone(
        saved.input === 'typed'
          ? { value: saved.value, input: 'typed' }
          : { image: saved.image, input: saved.input },
        false,
      )
      return
    }
    const keep = canSave && save
    if (mode === 'type') onDone({ value: typed.trim(), input: 'typed' }, keep)
    else if (mode === 'upload' && uploaded?.ok)
      onDone({ image: uploaded.image, input: 'uploaded' }, keep)
    else if (mode === 'draw' && canvas.current) {
      const image = inked(canvas.current).toDataURL('image/png')
      if (image.length > MAX_DRAWN_SIGNATURE_CHARS) setTooBig(true)
      else onDone({ image, input: 'drawn' }, keep)
    }
  }

  return (
    <Dialog
      title={kind === 'initials' ? 'Your initials' : 'Your signature'}
      onClose={onClose}
      testId="signature-dialog"
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2" role="tablist" aria-label={`How to add your ${label}`}>
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`rounded-full px-3 py-1 text-sm ${mode === m ? 'bg-ember text-paper-raised' : 'bg-paper-sunk text-ink'}`}
              onClick={() => {
                touched.current = true
                setMode(m)
              }}
              data-testid={`signature-${m}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        {mode === 'saved' && saved ? (
          <div className="flex flex-col gap-2 text-sm text-ink-soft">
            Your saved {label}
            <div
              className="flex min-h-24 items-center justify-center rounded-lg border border-ash-strong bg-white px-3 py-3"
              data-testid="signature-saved-preview"
            >
              <MarkPreview mark={saved} />
            </div>
          </div>
        ) : mode === 'type' ? (
          <label className="flex flex-col gap-1 text-sm text-ink-soft">
            Type your {label}
            <input
              className={inputClass}
              value={typed}
              maxLength={200}
              onChange={(e) => {
                touched.current = true
                setTyped(e.target.value)
              }}
              data-testid="signature-typed"
            />
            <span className="sign-script mt-2 truncate rounded-lg border border-ash-strong bg-white px-3 py-3 text-4xl">
              {typed || ' '}
            </span>
          </label>
        ) : mode === 'draw' ? (
          <div className="flex flex-col gap-2">
            <canvas
              ref={canvas}
              className="h-40 w-full touch-none rounded-lg border border-ash-strong bg-white"
              aria-label={`Draw your ${label} here`}
              data-testid="signature-canvas"
              onPointerDown={(e) => {
                const ctx = e.currentTarget.getContext('2d')
                if (!ctx) return
                e.currentTarget.setPointerCapture(e.pointerId)
                drawing.current = true
                const p = point(e)
                ctx.beginPath()
                ctx.moveTo(p.x, p.y)
                ctx.lineTo(p.x + 0.1, p.y + 0.1)
                ctx.stroke()
                setDrawn(true)
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return
                const ctx = e.currentTarget.getContext('2d')
                const p = point(e)
                ctx?.lineTo(p.x, p.y)
                ctx?.stroke()
              }}
              onPointerUp={() => {
                drawing.current = false
              }}
            />
            <button
              type="button"
              className="self-start text-sm text-ink-soft underline"
              onClick={() => {
                const el = canvas.current
                el?.getContext('2d')?.clearRect(0, 0, el.width, el.height)
                setDrawn(false)
                setTooBig(false)
              }}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <input
              ref={fileInput}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="signature-file"
              onChange={(e) => {
                void pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the button inside is the keyboard way in */}
            <div
              className={`flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-4 text-center text-sm ${dragOver ? 'border-ember bg-paper-sunk' : 'border-ash-strong bg-white'}`}
              data-testid="signature-drop"
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                void pick(e.dataTransfer.files[0])
              }}
            >
              {uploaded?.ok ? (
                <img
                  src={uploaded.image}
                  alt={`Your ${label}, cleaned up`}
                  className="max-h-28 max-w-full object-contain"
                  data-testid="signature-upload-preview"
                />
              ) : reading ? (
                <span className="text-ink-soft">Reading the picture…</span>
              ) : !picture ? (
                <span className="text-ink-soft">
                  Sign a sheet of white paper in dark ink and take a photo, or use a scan.
                </span>
              ) : null}
              <button
                type="button"
                className={secondaryButton}
                onClick={() => fileInput.current?.click()}
                data-testid="signature-choose"
              >
                {picture ? 'Choose another picture' : 'Choose a picture'}
              </button>
              <span className="text-xs text-ink-faint">or drag one here, or paste it</span>
            </div>
            {picture ? (
              <label className="flex items-center gap-3 text-sm text-ink-soft">
                Ink
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={strength}
                  onChange={(e) => setStrength(Number(e.target.value))}
                  className="flex-1"
                  aria-label="How much of the picture counts as ink"
                  data-testid="signature-ink"
                />
              </label>
            ) : null}
            {pickError || (uploaded && !uploaded.ok) ? (
              <p role="alert" className="text-sm text-ink" data-testid="signature-upload-error">
                {pickError ?? (uploaded && !uploaded.ok ? uploaded.message : '')}
              </p>
            ) : null}
          </div>
        )}
        {tooBig ? (
          <p role="alert" className="text-sm text-ink">
            That drawing is too detailed to keep. Clear it and draw your {label} a little simpler.
          </p>
        ) : null}
        {canSave && mode !== 'saved' ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
              data-testid="signature-save"
            />
            <span>
              Save as my {label} for next time
              {saved ? ' (replaces the saved one)' : ''}. Only you can see it.
            </span>
          </label>
        ) : null}
        <p className="text-xs text-ink-faint">
          {saving
            ? `Saved in your personal space. Only you can see it.`
            : canSave
              ? `This document keeps a copy of your ${label}, and its audit certificate says how you made it.`
              : `Your ${label} goes on this document only and is kept with it.`}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            data-testid="signature-done"
            disabled={!ready}
            onClick={finish}
          >
            {saving ? `Save this ${label}` : `Use this ${label}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

/** The drawing cropped to its ink, with a small margin, so it fills the field it goes in. */
function inked(source: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = source.getContext('2d')
  if (!ctx) return source
  const { width, height } = source
  const { data } = ctx.getImageData(0, 0, width, height)
  let [left, top, right, bottom] = [width, height, -1, -1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return source
  const pad = Math.round(Math.min(width, height) * 0.04)
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  const out = document.createElement('canvas')
  out.width = Math.min(width, right + pad + 1) - x
  out.height = Math.min(height, bottom + pad + 1) - y
  out.getContext('2d')?.drawImage(source, x, y, out.width, out.height, 0, 0, out.width, out.height)
  return out
}
