// The music button at the foot of the desktop rail (docs/PLAN-background-music.md): it opens the
// controls in a small panel beside the rail. A dot shows while music plays.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../components/Icon'
import { MusicPanel, musicStatus } from './MusicPanel'
import { useMusic } from './useMusic'

export function MusicButton({ className }: { className: string }) {
  const s = useMusic()
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const label = `Background music: ${musicStatus(s)}`

  const close = (focusButton = true) => {
    setAt(null)
    if (focusButton) buttonRef.current?.focus()
  }

  useEffect(() => {
    if (!at) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return
      close(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  })

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        aria-label={label}
        title={label}
        aria-expanded={at !== null}
        aria-haspopup="dialog"
        data-testid="music-button"
        data-playing={s.playing ? '' : undefined}
        onClick={(e) => {
          if (at) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ left: r.right + 8, bottom: window.innerHeight - r.bottom })
        }}
        className={className}
      >
        <Icon name="music" className="size-5" />
        {s.on ? (
          <span
            aria-hidden="true"
            className={`absolute top-1 right-2.5 size-1.5 rounded-full ${s.playing ? 'bg-ember' : 'bg-ash-strong'}`}
          />
        ) : null}
      </button>
      {at
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Background music"
              style={{ left: at.left, bottom: at.bottom }}
              className="fixed z-50 rounded-lg border border-ash bg-paper-raised p-3 shadow-float"
            >
              <MusicPanel autoFocus />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
