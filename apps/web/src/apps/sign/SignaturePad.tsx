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
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#16262d'
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
            <span className="sign-script mt-2 truncate rounded-lg bg-paper-sunk px-3 py-3 text-4xl text-ink">
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
              }}
            >
              Clear
            </button>
          </div>
        )}
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
              else if (canvas.current) onDone({ image: canvas.current.toDataURL('image/png') })
            }}
          >
            Use this {label}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
