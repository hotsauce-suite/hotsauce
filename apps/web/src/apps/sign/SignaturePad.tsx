import { MAX_DRAWN_SIGNATURE_CHARS } from '@hotsauce/format'
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { inputClass } from '../../routes/org/fields'
import { primaryButton, secondaryButton } from '../meetings/components/common'

export type Signature = { value: string } | { image: string }

/** Type or draw a signature (or initials); drawn ones are sent as a PNG data URL. */
export function SignatureDialog({
  kind,
  name,
  onDone,
  onClose,
}: {
  kind: 'signature' | 'initials'
  name: string
  onDone: (s: Signature) => void
  onClose: () => void
}) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
  const [mode, setMode] = useState<'type' | 'draw'>('type')
  const [typed, setTyped] = useState(kind === 'initials' ? initials : name)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  const [tooBig, setTooBig] = useState(false)
  const drawing = useRef(false)

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
  const label = kind === 'initials' ? 'initials' : 'signature'

  return (
    <Dialog
      title={kind === 'initials' ? 'Your initials' : 'Your signature'}
      onClose={onClose}
      testId="signature-dialog"
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2" role="tablist" aria-label={`How to add your ${label}`}>
          {(['type', 'draw'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`rounded-full px-3 py-1 text-sm ${mode === m ? 'bg-ember text-paper-raised' : 'bg-paper-sunk text-ink'}`}
              onClick={() => setMode(m)}
              data-testid={`signature-${m}`}
            >
              {m === 'type' ? 'Type' : 'Draw'}
            </button>
          ))}
        </div>
        {mode === 'type' ? (
          <label className="flex flex-col gap-1 text-sm text-ink-soft">
            Type your {label}
            <input
              className={inputClass}
              value={typed}
              maxLength={200}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="signature-typed"
            />
            <span className="sign-script mt-2 truncate rounded-lg border border-ash-strong bg-white px-3 py-3 text-4xl">
              {typed || ' '}
            </span>
          </label>
        ) : (
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
        )}
        {tooBig ? (
          <p role="alert" className="text-sm text-ink">
            That drawing is too detailed to keep. Clear it and draw your {label} a little simpler.
          </p>
        ) : null}
        <p className="text-xs text-ink-faint">
          Your {label} goes on this document only and is kept with it.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            data-testid="signature-done"
            disabled={mode === 'type' ? !typed.trim() : !drawn}
            onClick={() => {
              if (mode === 'type') onDone({ value: typed.trim() })
              else if (canvas.current) {
                const image = inked(canvas.current).toDataURL('image/png')
                if (image.length > MAX_DRAWN_SIGNATURE_CHARS) setTooBig(true)
                else onDone({ image })
              }
            }}
          >
            Use this {label}
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
